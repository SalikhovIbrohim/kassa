import type pg from "pg";
import type { Queryable } from "./balances.js";
import { cashDayStartSql } from "./cash-day.js";
import { isClientPayment, readCategories, type Category } from "./categories.js";
import { OPERATION_FROM, OPERATION_SELECT, inDollars, type LedgerEvents, type OperationRow } from "./ledger.js";
import { createSheetsClient, SheetsError, type SheetSettings, type SheetsClient } from "./sheets-api.js";

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type JournalSheetOptions = {
  pool: pg.Pool;
  /** Where the journal goes; undefined when no spreadsheet is set up: then nothing is queued. */
  settings: SheetSettings | undefined;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** How often the worker looks for what is due. */
  intervalMs?: number;
  /** The first wait after a failed try, in seconds; it doubles up to a quarter of an hour. */
  baseBackoffSeconds?: number;
  /** The clock of the waits between tries. */
  now?: () => Date;
};

/** The columns of the sheet, in order. The last one, the id of the entry, is how a row is found again. */
export const SHEET_HEADER = [
  "Дата и время (МСК)",
  "Кассир",
  "Операция",
  "Приход",
  "Расход",
  "Валюта",
  "Курс",
  "Клиент",
  "Рейс",
  "Контрагент",
  "Сотрудник",
  "Комментарий",
  "Статус",
  "ID записи",
] as const;
const LAST_COLUMN = "N";
const MAX_BACKOFF_SECONDS = 15 * 60;
/** A row that is being written is not offered to anybody else for this long. */
const LEASE_SECONDS = 60;

/** "14.10.2026 18:45" by the clock of the cash desk (Moscow). */
function moscowDateTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}`;
}

/** One row of the sheet for an entry, as it stands now. Sums and rates are numbers, so the sheet can add them up. */
export function sheetRow(row: OperationRow, categories: readonly Category[]): Array<string | number> {
  const amount = Number(row.amount_minor) / 100;
  const label = isClientPayment(row.kind, row.category)
    ? "Приход"
    : (categories.find((item) => item.code === row.category)?.label ?? row.category ?? (row.kind === "income" ? "Приход" : "Расход"));
  const { rateSource } = inDollars(row);
  const rateE4 = rateSource === "own" ? row.rate_e4 : rateSource === "day" ? row.day_average_rate_e4 : null;
  const comment = [row.recipient ? `Кому: ${row.recipient}` : "", row.comment ?? ""].filter(Boolean).join(". ");
  const status = row.deleted_at ? "удалена" : row.revision > 0 ? "изменена" : "";
  return [
    moscowDateTime(row.created_at),
    row.author_display_name,
    label,
    row.kind === "income" ? amount : "",
    row.kind === "expense" ? amount : "",
    row.currency === "RUB" ? "₽" : "$",
    rateE4 === null ? "" : Number(rateE4) / 10_000,
    row.client_code ?? "",
    row.trip_number ?? "",
    row.counterparty ?? "",
    row.employee ?? "",
    comment,
    status,
    row.id,
  ];
}

export type JournalSheet = {
  readonly enabled: boolean;
  /** Writes down, on the connection (the transaction) of the change, that the entry's row must be written again. */
  queue(db: Queryable, operationId: string): Promise<void>;
  nudge(): void;
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

/**
 * The copy of the journal in a Google spreadsheet. Every entry made since `from` has one row, written when it is made
 * and written again, as it stands then, when it is corrected or deleted (the row says «изменена» or «удалена»). The
 * rows go out one at a time, oldest first; one that Google does not take now holds the ones after it until it goes, so
 * the rows stay in the order the entries were made. Entries of before the copy was set up (but since `from`) are
 * queued when the worker starts. What the sheet is told is always read fresh, so writing a row twice does no harm.
 */
export function createJournalSheet(options: JournalSheetOptions): JournalSheet {
  const { pool, settings, log } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 10_000;
  const baseBackoff = options.baseBackoffSeconds ?? 15;
  const client: SheetsClient | undefined = settings && createSheetsClient(settings, options.fetchImpl);

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  let ready = false;

  const later = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  /** The tab is there and starts with the names of the columns. */
  async function prepare(): Promise<void> {
    if (ready) return;
    await client!.ensureTab();
    const [first] = await client!.read(`A1:${LAST_COLUMN}1`);
    if (!first || first.length === 0) await client!.write(`A1:${LAST_COLUMN}1`, [[...SHEET_HEADER]]);
    ready = true;
  }

  /** The entries since `from` that have no row and are not waiting for one: the ones of before the copy was set up. */
  async function queueMissing(): Promise<void> {
    await pool.query(
      `INSERT INTO sheet_outbox (operation_id, created_at, next_attempt_at)
       SELECT o.id, $1, $1 FROM operations o
        WHERE ($2::timestamptz IS NULL OR o.created_at >= $2)
          AND NOT EXISTS (SELECT 1 FROM sheet_rows r WHERE r.operation_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM sheet_outbox q WHERE q.operation_id = o.id)
        ORDER BY o.created_at, o.id`,
      [now(), settings!.from ?? null],
    );
  }

  async function claim(): Promise<{ id: string; operationId: string; attempts: number } | undefined> {
    const claimed = await pool.query<{ id: string; operation_id: string; attempts: number }>(
      `WITH head AS (SELECT id FROM sheet_outbox ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE sheet_outbox q SET attempts = q.attempts + 1, next_attempt_at = $2
         FROM head WHERE q.id = head.id AND q.next_attempt_at <= $1
       RETURNING q.id, q.operation_id, q.attempts`,
      [now(), later(LEASE_SECONDS)],
    );
    const row = claimed.rows[0];
    return row && { id: row.id, operationId: row.operation_id, attempts: row.attempts };
  }

  /** Writes the entry's row as the entry stands now: over its row, or as a new row under the others. */
  async function writeRow(operationId: string, attempts: number): Promise<void> {
    const found = await pool.query<OperationRow>(`SELECT ${OPERATION_SELECT} FROM ${OPERATION_FROM} WHERE o.id = $1`, [operationId]);
    const operation = found.rows[0];
    if (!operation) return;
    const values = sheetRow(operation, await readCategories(pool));
    let rowNumber = (await pool.query<{ row_number: number }>("SELECT row_number FROM sheet_rows WHERE operation_id = $1", [operationId])).rows[0]?.row_number;
    if (rowNumber === undefined && attempts > 1) {
      // A try before may have added the row and failed before its number was kept: look for the id, not to add it twice.
      const ids = await client!.read(`${LAST_COLUMN}:${LAST_COLUMN}`);
      const index = ids.findIndex((cells) => cells[0] === operationId);
      if (index >= 0) rowNumber = index + 1;
    }
    if (rowNumber === undefined) rowNumber = await client!.append(values);
    else await client!.write(`A${rowNumber}:${LAST_COLUMN}${rowNumber}`, [values]);
    await pool.query(
      "INSERT INTO sheet_rows (operation_id, row_number) VALUES ($1, $2) ON CONFLICT (operation_id) DO UPDATE SET row_number = EXCLUDED.row_number",
      [operationId, rowNumber],
    );
  }

  async function flushNow(): Promise<void> {
    if (!ready) {
      try {
        await prepare();
      } catch (error) {
        log.warn(`The Google spreadsheet of the journal is not ready: ${(error as Error).message}`);
        return;
      }
    }
    while (!stopped) {
      const item = await claim();
      if (!item) return;
      try {
        await writeRow(item.operationId, item.attempts);
        // The row says what the entry says now: whatever else waited for this entry, up to here, is written too.
        await pool.query("DELETE FROM sheet_outbox WHERE operation_id = $1 AND id <= $2", [item.operationId, item.id]);
      } catch (error) {
        const message = error instanceof SheetsError ? error.message : `The row could not be written: ${(error as Error).message}`;
        const wait = Math.min(MAX_BACKOFF_SECONDS, baseBackoff * 2 ** Math.min(item.attempts - 1, 10));
        log.warn(`The row of the entry ${item.operationId} did not go to the Google spreadsheet (try ${item.attempts}), the next try in ${wait} s: ${message}`);
        await pool.query("UPDATE sheet_outbox SET next_attempt_at = $2, last_error = $3 WHERE id = $1", [item.id, later(wait), message]);
        // In order: nothing after this one is written before it.
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await flushNow().catch((error: unknown) => log.error(`The rows for the Google spreadsheet could not be worked through: ${(error as Error).message}`));
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    enabled: settings !== undefined,
    async queue(db, operationId) {
      if (!settings) return;
      await db.query(
        `INSERT INTO sheet_outbox (operation_id, created_at, next_attempt_at)
         SELECT o.id, $2, $2 FROM operations o WHERE o.id = $1 AND ($3::timestamptz IS NULL OR o.created_at >= $3)`,
        [operationId, now(), settings.from ?? null],
      );
    },
    nudge() {
      if (!settings || stopped) return;
      setImmediate(() => void flush());
    },
    flush,
    start() {
      if (!settings || timer) return;
      timer = setInterval(() => void flush(), intervalMs);
      timer.unref();
      void queueMissing()
        .catch((error: unknown) => log.error(`The entries for the Google spreadsheet could not be queued: ${(error as Error).message}`))
        .then(() => flush());
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

/**
 * The rows to write again when the journal changes: the entry itself, and when a ruble income of a day is made or
 * changed, the ruble expenses of that day without a rate of their own, as their rate is the average of that day's.
 */
export function sheetEvents(sheet: JournalSheet): LedgerEvents | undefined {
  if (!sheet.enabled) return undefined;
  const touch = async (db: pg.PoolClient, row: OperationRow) => {
    await sheet.queue(db, row.id);
    if (row.kind !== "income" || row.currency !== "RUB") return;
    const sameDay = await db.query<{ id: string }>(
      `SELECT o.id FROM operations o
        WHERE o.kind = 'expense' AND o.currency = 'RUB' AND o.rate_e4 IS NULL
          AND ${cashDayStartSql("o.created_at")} = ${cashDayStartSql("$1::timestamptz")}
        ORDER BY o.created_at, o.id`,
      [row.created_at],
    );
    for (const { id } of sameDay.rows) await sheet.queue(db, id);
  };
  return {
    created: touch,
    changed: (db, event) => touch(db, event.row),
  };
}
