import type pg from "pg";
import { OneCError, createOneCClient, type Json, type OneCSettings } from "../onec-api.js";
import { readReferences } from "../onec-pko.js";
import { AdminError } from "./users.js";

/** The things a document refers to that must be there, with what each is told about in the base. */
const THINGS: Array<{ name: string; entity: string; key: (settings: OneCSettings) => string; expect?: string }> = [
  { name: "организация", entity: "Catalog_Организации", key: (settings) => settings.organizationKey },
  { name: "касса", entity: "Catalog_КассыОрганизаций", key: (settings) => settings.kassaKey, expect: "кассу, в которую идут приходы (например «Москва»)" },
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
  const done = await pool.query(
    `UPDATE onec_outbox SET status = 'pending', attempts = 0, alerted = false, next_attempt_at = now(), detail = NULL
      WHERE id = $1 AND status IN ('failed', 'blocked', 'skipped', 'preview') RETURNING doc_number`,
    [id],
  );
  if (done.rowCount === 0) {
    const row = (await pool.query<{ status: string }>("SELECT status FROM onec_outbox WHERE id = $1", [id])).rows[0];
    if (!row) throw new AdminError(`No payment ${id} in the queue of 1C`);
    throw new AdminError(`Payment ${id} is "${row.status}": only a payment that failed, waits, was skipped or was only looked at can be tried again`);
  }
  const document = (done.rows[0] as { doc_number: string | null }).doc_number;
  return `Payment ${id} is back in the queue${document ? ` (it goes on with the document ПКО №${document}, no second one is made)` : ""}. The running server takes it within a few seconds.`;
}

/** Stops writing a payment that is not written: it stays in the queue as skipped, and what is in 1C is left as it is. */
export async function onecSkip(pool: pg.Pool, idText: string | undefined): Promise<string> {
  const id = idOf(idText);
  const done = await pool.query(
    `UPDATE onec_outbox SET status = 'skipped', detail = 'пропущен вручную (onec-skip)'
      WHERE id = $1 AND status IN ('pending', 'blocked', 'failed', 'preview') RETURNING doc_number`,
    [id],
  );
  if (done.rowCount === 0) {
    const row = (await pool.query<{ status: string }>("SELECT status FROM onec_outbox WHERE id = $1", [id])).rows[0];
    if (!row) throw new AdminError(`No payment ${id} in the queue of 1C`);
    throw new AdminError(`Payment ${id} is "${row.status}": only a payment that is not written yet can be skipped`);
  }
  const document = (done.rows[0] as { doc_number: string | null }).doc_number;
  return `Payment ${id} will not be written to 1C.${document ? ` The document ПКО №${document} that was already made for it stays in 1C: look at it there.` : ""}`;
}
