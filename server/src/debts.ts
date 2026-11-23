import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { cashDayOf } from "./cash-day.js";
import { readControl, readDebtBook, readStatement, type Statement } from "./client-debts.js";
import { clientCodeIn, type ClientCodes } from "./clients.js";
import { closingOf, daysBetween, debtReport, isDay, MAX_PERIOD_DAYS, shiftDay, unpaidRows, UNPAID_SHEET_DAYS, type Closing, type UnpaidRow } from "./debt-report.js";
import { inTransaction } from "./ledger.js";
import { NO_NUL, NO_QUERY } from "./schemas.js";
import { workbook, type Cell } from "./xlsx.js";

export type DebtsOptions = {
  pool: pg.Pool;
  /** How the business writes the codes of its clients: «А707» unless said. */
  codes?: ClientCodes;
  /** The business keeps trips: only then do its clients have debts to look into. */
  cargo?: boolean;
  /** The application's clock: the day of the cash desk it is, and so which days have closed. */
  now?: () => Date;
  /** The main cash desk: the report marks what the other desks took. */
  primaryKassa?: string;
  log?: { error(message: string): void };
  /** How often it is looked whether a day has closed; tests make it short. */
  closingIntervalMs?: number;
  /** What a cash desk is called, for the sheets given out. */
  kassaLabel?: (kassa: string) => string;
};

/** The card of a client as a workbook of Excel: what they owed at the start, then every truck and every payment with the debt after it. */
export function statementWorkbook(statement: Statement, kassaLabel: (kassa: string) => string): Buffer {
  const money = (minor: number): Cell => ({ number: minor / 100, style: "money" });
  const rows: Cell[][] = statement.movements.map((line) => [
    { day: line.day },
    { text: line.kind === "trip" ? `Рейс ${line.tripNumber}` : line.kind === "refund" ? "Возврат клиенту" : "Оплата" },
    line.kind !== "trip" && line.kassa ? { text: kassaLabel(line.kassa) } : null,
    line.kind === "payment" ? null : money(line.amountMinor),
    line.kind === "payment" ? money(line.amountMinor) : null,
    money(line.debtMinor),
    line.note ? { text: line.note } : null,
  ]);
  const header = ["Дата", "Что", "Касса", "Начислено", "Оплачено", "Долг", "Заметка"];
  return workbook({
    name: `${statement.code} ${statement.name}`,
    widths: [12, 20, 12, 13, 13, 13, 30],
    rows: [header.map((text) => ({ text, style: "header" as const })), [null, { text: "Долг на начало", style: "bold" }, null, null, null, { number: statement.openingDebtMinor / 100, style: "boldMoney" }, null], ...rows],
    filterRows: rows.length + 1,
  });
}

const SNAPSHOT = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
/** The days that are closed at one go, when the server was not running for long: older ones stay without a closing. */
const MAX_CLOSINGS_AT_ONCE = 62;

/**
 * Keeps the closing of every day that is over and has none yet (see `debt_closings`): what each client owed at the end
 * of it, as the book has it at this moment. The first time, only the day that has just ended; afterwards every day
 * since the last one kept, so a server that was down over a night closes that night when it is back. Returns the
 * days it closed. Two of these at once close a day once: the second finds it kept.
 */
export async function keepClosings(pool: pg.Pool, codes: ClientCodes, now: Date): Promise<string[]> {
  const yesterday = shiftDay(cashDayOf(now), -1);
  const kept = await pool.query<{ last: string | null }>("SELECT to_char(MAX(day), 'YYYY-MM-DD') AS last FROM debt_closings");
  const last = kept.rows[0]?.last ?? null;
  if (last !== null && last >= yesterday) return [];
  const first = last === null ? yesterday : shiftDay(yesterday, -Math.min(daysBetween(last, yesterday), MAX_CLOSINGS_AT_ONCE) + 1);
  return inTransaction(
    pool,
    async (db) => {
      const book = await readDebtBook(db, codes);
      const closed: string[] = [];
      // With no client in the directory there is nothing to keep: a closing of nothing would only make the first
      // clients that are loaded later look like something written into the past.
      if (book.clients.length === 0) return closed;
      for (let day = first; day <= yesterday; day = shiftDay(day, 1)) {
        const closing = closingOf(book, day);
        const written = await db.query(
          "INSERT INTO debt_closings (day, taken_at, total_minor, debts, top, overdue) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (day) DO NOTHING",
          [day, now, closing.totalMinor, JSON.stringify(closing.debts), JSON.stringify(closing.top), JSON.stringify(closing.overdue)],
        );
        if (written.rowCount) closed.push(day);
      }
      return closed;
    },
    "BEGIN ISOLATION LEVEL REPEATABLE READ",
  );
}

async function readClosing(db: { query: pg.Pool["query"] }, day: string): Promise<Closing | null> {
  const found = await db.query<{ taken_at: Date; total_minor: string; debts: Record<string, number>; top: string[]; overdue: string[] }>(
    "SELECT taken_at, total_minor, debts, top, overdue FROM debt_closings WHERE day = $1",
    [day],
  );
  const row = found.rows[0];
  return row ? { day, takenAt: row.taken_at, totalMinor: Number(row.total_minor), debts: row.debts, top: row.top, overdue: row.overdue } : null;
}

const formatDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** The sheet «Не платят больше 7 дней» as a workbook of Excel: the filter over the header, the totals under the rows, the days in three colors. */
export function unpaidWorkbook(rows: readonly UnpaidRow[], day: string): Buffer {
  const header = ["№", "Клиент", "Код", "Телефон", "Долг $", "Последняя оплата", "Сумма посл. оплаты", "Дней без оплаты", "Последний рейс", "Дата рейса", "Сумма по рейсу", `Оплачено в ${day.slice(0, 4)}`];
  const money = (minor: number): Cell => ({ number: minor / 100, style: "money" });
  const table: Cell[][] = rows.map((row, index) => [
    { number: index + 1, style: "count" },
    { text: row.name },
    { text: row.code },
    row.phone ? { text: row.phone } : null,
    money(row.debtMinor),
    row.lastPaidDay ? { day: row.lastPaidDay } : { text: "нет" },
    row.lastPaidDay ? money(row.lastPaidMinor) : null,
    { number: row.daysUnpaid, style: row.daysUnpaid >= 90 ? "red" : row.daysUnpaid >= 30 ? "orange" : "yellow" },
    row.lastTrip ? { number: row.lastTrip.number, style: "count" } : null,
    row.lastTrip ? { day: row.lastTrip.day } : null,
    row.lastTrip ? money(row.lastTrip.amountMinor) : null,
    money(row.paidInYearMinor),
  ]);
  const last = rows.length + 1;
  // The totals follow the filter: they add up the rows that are shown.
  const sum = (column: string, minor: number): Cell => (rows.length > 0 ? { formula: `SUBTOTAL(109,${column}2:${column}${last})`, value: minor / 100, style: "boldMoney" } : { number: 0, style: "boldMoney" });
  const totals: Cell[] = [
    null,
    { text: `Итого на ${formatDay(day)}: ${rows.length}`, style: "bold" },
    null,
    null,
    sum("E", rows.reduce((all, row) => all + row.debtMinor, 0)),
    null,
    null,
    null,
    null,
    null,
    null,
    sum("L", rows.reduce((all, row) => all + row.paidInYearMinor, 0)),
  ];
  return workbook({
    name: `Не платят ${UNPAID_SHEET_DAYS}+ дней`,
    widths: [5, 26, 8, 18, 13, 13, 13, 10, 10, 12, 13, 14],
    rows: [header.map((text) => ({ text, style: "header" as const })), ...table, totals],
    filterRows: rows.length,
  });
}

/**
 * What the owner and the admin look into behind the debt of a client: the card of the client (every trip that arrived
 * and every payment, with the debt after each) and the control sheet of a year (what all the clients owed, month by
 * month). Both are what the card file of the business had on paper; both are worked out from the trips and the
 * payments, and stored nowhere. A business that keeps no trips has neither.
 */
export async function registerDebts(app: FastifyInstance, options: DebtsOptions) {
  const { pool } = options;
  const codes = options.codes ?? "letter";
  const lookers = [app.authenticate, app.requireRole("admin", "viewer")];
  const snapshot = SNAPSHOT;
  const now = options.now ?? (() => new Date());

  // The days close by themselves: looked at when the server starts and every few minutes after, and before every
  // report, so that a report never waits for the clock of this watch.
  let watch: NodeJS.Timeout | undefined;
  const close = () => keepClosings(pool, codes, now()).catch((error: unknown) => void options.log?.error(`The closing of the day could not be kept: ${(error as Error).message}`));
  if (options.cargo) {
    app.addHook("onReady", async () => {
      watch = setInterval(() => void close(), options.closingIntervalMs ?? 5 * 60 * 1000);
      watch.unref();
      void close();
    });
    app.addHook("onClose", async () => {
      if (watch) clearInterval(watch);
    });
  }

  // The card of a client is read by whoever reads the report on the debts: its lists open the card of a client.
  const cardReaders = [app.authenticate, app.requireRole("cashier", "head_cashier", "admin", "viewer")];

  // The same card as a workbook of Excel: a line to a truck and to a payment, oldest first, as the card file had it.
  app.get<{ Params: { code: string } }>(
    "/api/clients/:code/statement.xlsx",
    {
      onRequest: cardReaders,
      schema: { params: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 20, pattern: NO_NUL } } }, querystring: NO_QUERY },
    },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      const code = clientCodeIn(request.params.code, codes);
      const statement = code ? await inTransaction(pool, (db) => readStatement(db, codes, code), snapshot) : undefined;
      if (!statement) return reply.code(404).send({ error: "not_found" });
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="client-${encodeURIComponent(statement.code)}.xlsx"`)
        .send(statementWorkbook(statement, options.kassaLabel ?? ((kassa) => kassa)));
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/clients/:code/statement",
    {
      onRequest: cardReaders,
      schema: { params: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 20, pattern: NO_NUL } } }, querystring: NO_QUERY },
    },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      const code = clientCodeIn(request.params.code, codes);
      const statement = code ? await inTransaction(pool, (db) => readStatement(db, codes, code), snapshot) : undefined;
      if (!statement) return reply.code(404).send({ error: "not_found" });
      return statement;
    },
  );

  app.get<{ Querystring: { year?: string } }>(
    "/api/debts/control",
    {
      onRequest: lookers,
      schema: { querystring: { type: "object", additionalProperties: false, properties: { year: { type: "string", pattern: "^20[0-9]{2}$" } } } },
    },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      // Without a year: the one that is running, by the calendar of Moscow.
      const year = Number(request.query.year ?? new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 4));
      return { year, months: await inTransaction(pool, (db) => readControl(db, codes, year), snapshot) };
    },
  );

  // The report of a day is for everybody who works with the money: the cashiers of every desk read it as the owner does.
  const readers = [app.authenticate, app.requireRole("cashier", "head_cashier", "admin", "viewer")];
  const DAY = { type: "string", pattern: "^20[0-9]{2}-[0-9]{2}-[0-9]{2}$" } as const;

  /** The day asked for (today's without one); undefined for a day that is no day or has not come yet. */
  const askedDay = (day: string | undefined): string | undefined => {
    const today = cashDayOf(now());
    if (day === undefined) return today;
    return isDay(day) && day <= today ? day : undefined;
  };

  app.get<{ Querystring: { day?: string; since?: string } }>(
    "/api/debts/report",
    { onRequest: readers, schema: { querystring: { type: "object", additionalProperties: false, properties: { day: DAY, since: DAY } } } },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      const day = askedDay(request.query.day);
      if (!day) return reply.code(400).send({ error: "bad_day" });
      // Compared with the day before, unless the last closing looked at was an earlier one (a weekend, a holiday).
      const since = request.query.since ?? shiftDay(day, -1);
      if (!isDay(since) || since >= day || daysBetween(since, day) > MAX_PERIOD_DAYS) return reply.code(400).send({ error: "bad_period" });
      await keepClosings(pool, codes, now());
      return inTransaction(
        pool,
        async (db) => debtReport(await readDebtBook(db, codes), { day, since, primaryKassa: options.primaryKassa ?? "", closing: await readClosing(db, since) }),
        snapshot,
      );
    },
  );

  app.get<{ Querystring: { day?: string } }>(
    "/api/debts/unpaid.xlsx",
    { onRequest: readers, schema: { querystring: { type: "object", additionalProperties: false, properties: { day: DAY } } } },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      const day = askedDay(request.query.day);
      if (!day) return reply.code(400).send({ error: "bad_day" });
      const rows = await inTransaction(pool, async (db) => unpaidRows(await readDebtBook(db, codes), day), snapshot);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="unpaid-${day}.xlsx"`)
        .send(unpaidWorkbook(rows, day));
    },
  );
}
