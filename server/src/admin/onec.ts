import type pg from "pg";
import { OneCError, createOneCClient, type Json, type OneCSettings } from "../onec-api.js";
import { readReferences } from "../onec-pko.js";
import { retryPayment, skipPayment } from "../onec-admin.js";
import { AdminError } from "./users.js";

/** The things a document refers to that must be there, with what each is told about in the base. */
const THINGS: Array<{ name: string; entity: string; key: (settings: OneCSettings) => string; expect?: string }> = [
  { name: "организация", entity: "Catalog_Организации", key: (settings) => settings.organizationKey },
  { name: "касса", entity: "Catalog_КассыОрганизаций", key: (settings) => settings.kassaKey, expect: "касса, в которую идут приходы (например «Москва»)" },
  { name: "валюта", entity: "Catalog_Валюты", key: (settings) => settings.currencyKey, expect: "«Доллар» (в этой базе его код 860)" },
];

/**
 * A look at 1C that changes nothing: whether it answers, whether the login is taken, whether the accounts, the item of
 * the payments and the keys of the organization, cash desk and currency are there. Says what it found, line by line,
 * and whether all is well. Never says the address, the login or the password.
 */
export async function checkOneC(settings: OneCSettings, say: (line: string) => void): Promise<boolean> {
  const client = createOneCClient(settings);
  let good = true;
  const fail = (line: string) => {
    good = false;
    say(`  ПРОБЛЕМА: ${line}`);
  };
  const reason = (error: unknown) => (error instanceof OneCError ? error.message : "непредвиденная ошибка");

  say("Связь с 1С:");
  let counterparts: Json[];
  try {
    counterparts = await client.all("Catalog_Контрагенты", "Ref_Key,Description,ИНН,DeletionMark,IsFolder");
    say(`  ответила, логин принят, контрагентов в справочнике: ${counterparts.length}`);
  } catch (error) {
    fail(reason(error));
    return false;
  }

  say("Счета и статья ДДС:");
  try {
    const found = await readReferences(client);
    if ("missing" in found) fail(found.missing);
    else say("  счета 5010, 4010, 6310 и статья «Оплата от покупателей» на месте");
  } catch (error) {
    fail(reason(error));
  }

  say("Ключи из настроек:");
  for (const thing of THINGS) {
    try {
      const row = await client.get(`/${thing.entity}(guid'${thing.key(settings)}')`, { $select: "Ref_Key,Description" });
      say(`  ${thing.name}: «${String(row.Description ?? "")}»${thing.expect ? `, это должна быть ${thing.expect}` : ""}`);
    } catch (error) {
      fail(`${thing.name}: ${reason(error)}`);
    }
  }

  say(
    settings.onlyClients
      ? `Клиенты, которых записываем: ${settings.onlyClients.join(", ")} (COSMO_1C_CLIENTS), остальные пропускаются.`
      : "Список клиентов (COSMO_1C_CLIENTS) не задан: записываются приходы всех клиентов.",
  );
  say(`Режим: ${settings.mode === "live" ? "БОЕВОЙ (пишет в 1С)" : "репетиция (в 1С ничего не пишется)"}.`);
  say(settings.send === "now" ? "Отправка: сразу после записи (COSMO_1C_SEND=now)." : "Отправка: раз в сутки, в 03:00 МСК, когда день кассы закрыт.");
  return good;
}

type Row = {
  id: string;
  status: string;
  attempts: number;
  doc_number: string | null;
  detail: string | null;
  created_at: Date;
  client_code: string | null;
  currency: string;
  amount_minor: string;
};

/** The latest payments of the queue for 1C, one line each, and how many wait in each state. */
export async function onecStatus(pool: pg.Pool, limit: number): Promise<string[]> {
  const counts = await pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM onec_outbox GROUP BY status ORDER BY status");
  if (counts.rows.length === 0) return ["Очередь 1С пуста: ни один приход клиента ещё не ставился на запись."];
  const rows = await pool.query<Row>(
    `SELECT q.id::text, q.status, q.attempts, q.doc_number, q.detail, q.created_at, o.client_code, o.currency, o.amount_minor::text
       FROM onec_outbox q JOIN operations o ON o.id = q.operation_id
      ORDER BY q.id DESC LIMIT $1`,
    [limit],
  );
  const lines = [`Всего: ${counts.rows.map((row) => `${row.status} ${row.n}`).join(", ")}.`, "Последние (номер, состояние, приход, что с ним):"];
  for (const row of rows.rows) {
    const amount = new Intl.NumberFormat("ru-RU", { style: "currency", currency: row.currency }).format(Number(row.amount_minor) / 100);
    const when = row.created_at.toISOString().slice(0, 16).replace("T", " ");
    const document = row.doc_number ? ` ПКО №${row.doc_number}` : "";
    lines.push(`  ${row.id}  ${row.status.padEnd(8)}  ${when} UTC  ${row.client_code ?? "?"}  ${amount}${document}${row.detail ? `  ${row.detail}` : ""}`);
  }
  return lines;
}

const idOf = (text: string | undefined): number => {
  if (!text || !/^\d+$/.test(text.trim())) throw new AdminError("--id is required: the number from onec-status");
  return Number(text.trim());
};

/**
 * Puts a payment that was not written back in the queue: one that failed, waits, was skipped, or was only looked at in the
 * rehearsal. A payment that is written is never written again.
 */
export async function onecRetry(pool: pg.Pool, idText: string | undefined): Promise<string> {
  const id = idOf(idText);
  const result = await retryPayment(pool, id);
  if (!result.done) {
    if (result.status === null) throw new AdminError(`No payment ${id} in the queue of 1C`);
    throw new AdminError(`Payment ${id} is "${result.status}": only a payment that failed, waits, was skipped or was only looked at can be tried again`);
  }
  return `Payment ${id} is back in the queue${result.docNumber ? ` (it goes on with the document ПКО №${result.docNumber}, no second one is made)` : ""}. The running server takes it within a few seconds.`;
}

/** Stops writing a payment that is not written: it stays in the queue as skipped, and what is in 1C is left as it is. */
export async function onecSkip(pool: pg.Pool, idText: string | undefined): Promise<string> {
  const id = idOf(idText);
  const result = await skipPayment(pool, id, "пропущен вручную (onec-skip)");
  if (!result.done) {
    if (result.status === null) throw new AdminError(`No payment ${id} in the queue of 1C`);
    throw new AdminError(`Payment ${id} is "${result.status}": only a payment that is not written yet can be skipped`);
  }
  return `Payment ${id} will not be written to 1C.${result.docNumber ? ` The document ПКО №${result.docNumber} that was already made for it stays in 1C: look at it there.` : ""}`;
}

/** What the cash receipts' sibling, the cash payment order (РКО), is called in the base. */
const PAYMENT_ENTITY = "Document_РасходныйКассовыйОрдер";

/**
 * A look at how the accountant books the expenses, to draw the scheme of each category of the cash desk from what is
 * done already rather than guess it: the last cash payment orders, grouped by the kind of operation, the account
 * debited, the item of the cash flow and the kinds of analytics of the debit, with how many and a few of their
 * comments. Also the cash desks of the base, with their keys. Reads only; never says the address, the login or the
 * password.
 */
export async function studyExpenses(settings: OneCSettings, say: (line: string) => void, limit = 300): Promise<void> {
  const client = createOneCClient(settings);
  const accounts = await client.all("ChartOfAccounts_Хозрасчетный", "Ref_Key,Code,Description");
  const account = new Map(accounts.map((row) => [String(row.Ref_Key), `${String(row.Code)} ${String(row.Description ?? "")}`.trim()]));
  const items = await client.all("Catalog_СтатьиДвиженияДенежныхСредств", "Ref_Key,Description");
  const item = new Map(items.map((row) => [String(row.Ref_Key), String(row.Description ?? "")]));

  say("Кассы в базе (название и ключ для настроек):");
  for (const kassa of await client.all("Catalog_КассыОрганизаций", "Ref_Key,Description,DeletionMark")) {
    if (kassa.DeletionMark === true) continue;
    say(`  «${String(kassa.Description ?? "")}»  ${String(kassa.Ref_Key)}`);
  }

  const found = (await client.get(`/${PAYMENT_ENTITY}`, { $top: String(limit), $orderby: "Date desc", $filter: "Posted eq true" })) as { value?: Json[] };
  const documents = found.value ?? [];
  say("");
  say(`Последние проведённые РКО: ${documents.length}.`);
  if (documents.length === 0) return;

  type Group = { count: number; examples: string[]; fields: Set<string> };
  const groups = new Map<string, Group>();
  const kindOf = (type: unknown) => String(type ?? "").replace(/^StandardODATA\./, "").replace(/^Catalog_/, "") || "—";
  for (const document of documents) {
    const ref = String(document.Ref_Key);
    const register = (await client.get(`/AccountingRegister_Хозрасчетный(Recorder=guid'${ref}',Recorder_Type='StandardODATA.${PAYMENT_ENTITY}')`)) as { RecordSet?: Json[] };
    const lines = (register.RecordSet ?? []).filter((line) => line.Active !== false);
    const debits = [...new Set(lines.map((line) => account.get(String(line.AccountDr_Key)) ?? "?"))].join(" + ") || "без проводок";
    const analytics = [...new Set(lines.flatMap((line) => [1, 2, 3].map((n) => line[`ExtDimensionDr${n}_Type`]).filter(Boolean).map(kindOf)))].join(", ") || "—";
    const operation = String(document["ВидОперации"] ?? "?");
    const flow = item.get(String(document["СтатьяДвиженияДенежныхСредств_Key"] ?? "")) ?? "—";
    const key = `${operation} | Дт ${debits} | ДДС «${flow}» | аналитика: ${analytics}`;
    const group = groups.get(key) ?? { count: 0, examples: [], fields: new Set<string>() };
    group.count += 1;
    const note = String(document["Основание"] ?? document["Комментарий"] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (note && group.examples.length < 3 && !group.examples.includes(note)) group.examples.push(note);
    // The fields this kind of operation fills, so that the cash desk fills the same ones.
    for (const [name, value] of Object.entries(document)) {
      if (value === null || value === "" || value === false || value === 0 || name.startsWith("odata.") || name === "Ref_Key" || name === "DataVersion") continue;
      if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(String(value))) continue;
      group.fields.add(name);
    }
    groups.set(key, group);
  }

  say("Как они проведены (вид операции | счёт Дт | статья ДДС | аналитика счёта Дт), сколько раз и примеры оснований:");
  for (const [key, group] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
    say("");
    say(`  ${group.count} × ${key}`);
    if (group.examples.length > 0) say(`      например: ${group.examples.map((text) => `«${text}»`).join(", ")}`);
    say(`      заполненные поля: ${[...group.fields].sort().join(", ")}`);
  }
}
