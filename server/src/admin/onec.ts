import type pg from "pg";
import { OneCError, createOneCClient, type Json, type OneCSettings } from "../onec-api.js";
import { readReferences } from "../onec-pko.js";
import { readExpenseLists } from "../onec-rko.js";
import { readServiceReferences } from "../onec-services.js";
import { retryPayment, skipPayment } from "../onec-admin.js";
import { AdminError } from "./users.js";

/**
 * The things a document refers to that must be there, with what each is told about in the base. A cash desk of the
 * installation that has a cash desk of its own in the base (`kassaKeys`) is looked at too.
 */
function thingsOf(settings: OneCSettings): Array<{ name: string; entity: string; key: string; expect?: string }> {
  return [
    { name: "организация", entity: "Catalog_Организации", key: settings.organizationKey },
    { name: "касса", entity: "Catalog_КассыОрганизаций", key: settings.kassaKey, expect: "касса, в которую идут приходы (например «Москва»)" },
    ...Object.entries(settings.kassaKeys ?? {}).map(([id, key]) => ({
      name: `касса для ${id}`,
      entity: "Catalog_КассыОрганизаций",
      key,
      expect: `касса, в которую идут приходы кассы ${id}`,
    })),
    { name: "валюта", entity: "Catalog_Валюты", key: settings.currencyKey, expect: "«Доллар» (в этой базе его код 860)" },
  ];
}

/**
 * A look at 1C that changes nothing: whether it answers, whether the login is taken, whether the accounts, the item of
 * the payments and the keys of the organization, cash desk and currency are there. Says what it found, line by line,
 * and whether all is well. Never says the address, the login or the password.
 */
export async function checkOneC(settings: OneCSettings, say: (line: string) => void, kassas?: readonly string[]): Promise<boolean> {
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
  for (const thing of thingsOf(settings)) {
    try {
      const row = await client.get(`/${thing.entity}(guid'${thing.key}')`, { $select: "Ref_Key,Description" });
      say(`  ${thing.name}: «${String(row.Description ?? "")}»${thing.expect ? `, это должна быть ${thing.expect}` : ""}`);
    } catch (error) {
      fail(`${thing.name}: ${reason(error)}`);
    }
  }

  const documents = settings.documents ?? [];
  if (documents.includes("expenses")) {
    say("Справочники для расходных ордеров:");
    try {
      const found = await readExpenseLists(client);
      if ("missing" in found) fail(found.missing);
      else {
        const { lists } = found;
        say(`  счета 2010 и 9430 на месте; статей затрат: ${lists.costItems.length}, статей движения денег: ${lists.flowItems.length}, подразделений (рейсов): ${lists.departments.length}`);
        for (const name of ["Основная группа"]) if (!lists.groups.some((item) => item.name === name)) fail(`нет номенклатурной группы «${name}»`);
        if (!lists.otherItems.some((item) => item.name === "Прочие внереализационные доходы (расходы)")) fail("в прочих доходах и расходах нет «Прочие внереализационные доходы (расходы)»");
        if (!lists.costItems.some((item) => item.name === "Прочие расходы")) fail("нет статьи затрат «Прочие расходы»");
      }
    } catch (error) {
      fail(reason(error));
    }
  }
  if (documents.includes("trips")) {
    say("Справочники для рейсов («Оказание услуг»):");
    try {
      const found = await readServiceReferences(client);
      if ("missing" in found) fail(found.missing);
      else say("  счета 9030.1, 9130.1, 4010, 6310, услуга «Рейс» и группа «Основная группа» на месте");
    } catch (error) {
      fail(reason(error));
    }
  }
  const NAMES = { incomes: "любые приходы с кодом клиента", expenses: "расходы кассы (РКО)", trips: "прибывшие рейсы («Оказание услуг»)" } as const;
  say(
    documents.length > 0
      ? `Кроме оплат клиентов записываются: ${documents.map((name) => NAMES[name]).join("; ")} (ONEC_DOCUMENTS).`
      : "Записываются только оплаты клиентов (ONEC_DOCUMENTS не задана: incomes, expenses, trips).",
  );
  say(settings.from ? `Записывается всё начиная с дня кассы ${settings.from} (ONEC_FROM); более раннее не трогается.` : "Первый день записи (ONEC_FROM) не задан: записывается всё, что вносится с момента включения.");
  say(settings.createClients ? "Клиент, которого нет в 1С, создаётся вместе с договором (ONEC_CREATE_CLIENTS=yes)." : "Клиент, которого нет в 1С, не создаётся: его приход ждёт человека (ONEC_CREATE_CLIENTS).");
  if (kassas) say(`Кассы, приходы клиентов которых записываются: ${kassas.join(", ")} (ONEC_KASSAS; без неё только основная касса).`);
  say(
    settings.onlyClients
      ? `Клиенты, которых записываем: ${settings.onlyClients.join(", ")} (ONEC_CLIENTS), остальные пропускаются.`
      : "Список клиентов (ONEC_CLIENTS) не задан: записываются приходы всех клиентов.",
  );
  say(`Режим: ${settings.mode === "live" ? "БОЕВОЙ (пишет в 1С)" : "репетиция (в 1С ничего не пишется)"}.`);
  say(settings.send === "now" ? "Отправка: сразу после записи (ONEC_SEND=now)." : "Отправка: раз в сутки, в 03:00 МСК, когда день кассы закрыт.");
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
  kind: string | null;
  label: string | null;
  trip: number | null;
};

/** The latest payments of the queue for 1C, one line each, and how many wait in each state. */
export async function onecStatus(pool: pg.Pool, limit: number): Promise<string[]> {
  const counts = await pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM onec_outbox GROUP BY status ORDER BY status");
  if (counts.rows.length === 0) return ["Очередь 1С пуста: ни один приход клиента ещё не ставился на запись."];
  const rows = await pool.query<Row>(
    `SELECT q.id::text, q.status, q.attempts, q.doc_number, q.detail, q.created_at, o.client_code, o.currency, o.amount_minor::text, o.kind, c.label, t.number AS trip
       FROM onec_outbox q LEFT JOIN operations o ON o.id = q.operation_id LEFT JOIN categories c ON c.code = o.category LEFT JOIN trips t ON t.id = q.trip_id
      ORDER BY q.id DESC LIMIT $1`,
    [limit],
  );
  const lines = [`Всего: ${counts.rows.map((row) => `${row.status} ${row.n}`).join(", ")}.`, "Последние (номер, состояние, приход, что с ним):"];
  for (const row of rows.rows) {
    if (row.trip !== null) {
      lines.push(`  ${row.id}  ${row.status.padEnd(8)}  ${row.created_at.toISOString().slice(0, 16).replace("T", " ")} UTC  рейс ${row.trip}${row.doc_number ? `  Оказание услуг №${row.doc_number}` : ""}${row.detail ? `  ${row.detail}` : ""}`);
      continue;
    }
    const amount = new Intl.NumberFormat("ru-RU", { style: "currency", currency: row.currency }).format(Number(row.amount_minor) / 100);
    const when = row.created_at.toISOString().slice(0, 16).replace("T", " ");
    const document = row.doc_number ? ` ${row.kind === "expense" ? "РКО" : "ПКО"} №${row.doc_number}` : "";
    lines.push(`  ${row.id}  ${row.status.padEnd(8)}  ${when} UTC  ${row.kind === "expense" ? `расход «${row.label ?? ""}»` : (row.client_code ?? "?")}  ${amount}${document}${row.detail ? `  ${row.detail}` : ""}`);
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
