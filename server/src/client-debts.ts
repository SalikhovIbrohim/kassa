import type { Queryable } from "./balances.js";
import { cashDayOf, cashDaySql } from "./cash-day.js";
import type { ClientCodes } from "./clients.js";
import { dayAverageRateSql } from "./ledger.js";

/**
 * What a client owes, in cents of a dollar. Nothing of it is stored: it is worked out, every time it is asked for,
 * from the trips (what the cargo of the client on the trucks that have arrived comes to) and from the payments (what
 * the entries of the cash book that name the client took in and gave back). So the cash desk and the trips can never
 * say two different debts of one client.
 *
 * A business that kept its trips and its payments in a card file before has that history here too, taken over from
 * the file: what a client owed for a trip of before (`trip_sums`: a sum, where a trip kept here has the lines of its
 * waybill) and what they paid before (`past_payments`: no entries of the cash book, and in no balance of a cash
 * desk). Both count in a debt exactly as what is kept here does.
 */
export type ClientDebt = {
  /** What the client owed on the day the history begins; less than nothing is money paid ahead. */
  openingDebtMinor: number;
  /** What the cargo of the client comes to on the trips that have arrived. */
  chargedMinor: number;
  /** What the client paid, less what was given back to them. */
  paidMinor: number;
  /** Opening + charged - paid: more than nothing, the client owes; less, they have paid ahead. */
  debtMinor: number;
  /** The day of the last payment (money given back is none), and the day the last truck with their cargo came; null: never. */
  lastPaidDay: string | null;
  lastTripDay: string | null;
  /**
   * How many days the client has not paid for, up to `today`: since the last payment, or, with no payment at all,
   * since the history began (the first of January of the year of its oldest line), as the report on the debts counts.
   */
  daysUnpaid: number;
};

/**
 * SQL for what lines of cargo come to in cents: `micro` is the sum of weight (grams) times price (thousandths of a
 * dollar for a kilogram) of the lines, which is millionths of a dollar. Rounded to the nearest cent, half up, once
 * for the whole sum: a client owes for a trip what its lines come to together, as the card file of the business has it.
 */
export const centsOfMicroSql = (micro: string) => `floor((${micro} + 5000) / 10000)`;

/** The same in the code: millionths of a dollar to cents, half up. Whole numbers all the way. */
export const centsOfMicro = (micro: number) => Math.floor((micro + 5000) / 10000);

/**
 * SQL for the code of the client an entry of the cash desk names, the way the directory writes it: the entry says
 * "707 Карим" (or what was typed before there was a directory), the directory says 707. The same reading as
 * `clientCodeIn`; null when the text does not begin with a code.
 */
export function entryClientCodeSql(column: string, codes: ClientCodes): string {
  return codes === "digits"
    ? `substring(${column} from '^\\s*([0-9]{1,9}(?:-[0-9]{1,3})?)(?:\\s|$)')`
    : `('А' || substring(${column} from '^\\s*(?:[AaАа]\\s*-?\\s*)?([0-9]{1,5}(?:-[0-9]{1,3})?)(?:\\s|$)'))`;
}

/**
 * SQL for what the cargo on a truck comes to, line by line and sum by sum, in millionths of a dollar: the lines of a
 * waybill kept here, and for a trip of the history the sum of each client.
 */
export const CARGO_MICRO_SQL = `SELECT trip_id, client_code, weight_g::numeric * price_milli AS micro FROM trip_cargo WHERE deleted_at IS NULL
        UNION ALL
        SELECT trip_id, client_code, amount_micro::numeric AS micro FROM trip_sums`;

/**
 * SQL for what the clients owe for the trips that have arrived: a row to a client and a trip (`code`, `number`, the
 * day of the arrival `day`, cents `minor`). Each trip is rounded by itself.
 */
const CHARGES_SQL = `SELECT x.client_code AS code, t.number, t.arrival_day AS day, ${centsOfMicroSql("SUM(x.micro)")} AS minor
            FROM (${CARGO_MICRO_SQL}) x JOIN trips t ON t.id = x.trip_id
           WHERE t.deleted_at IS NULL AND t.status = 'arrived'
           GROUP BY x.client_code, t.id, t.number, t.arrival_day`;

/**
 * SQL for what the clients paid, a row to a payment (`code`, the day `day`, cents `minor`, the cash desk `kassa`,
 * `source`, `note`, and `at` to put the payments of a day in order).
 *
 * From the cash book: every entry that names a client and is not deleted. An income is a payment, an expense is money
 * given back to the client (a payment of less than nothing). Dollars are what they are; rubles are counted at the rate
 * of the entry (for an expense without one, the average of its day), as the journal shows them, and an entry that has
 * no rate at all yet is left out until it has one. Its day is its day of the cash desk.
 * From the history: the payments of before, as the card file had them.
 */
function paymentsSql(codes: ClientCodes): string {
  return `SELECT code, day, CASE WHEN kind = 'income' THEN usd ELSE -usd END AS minor, kassa, 'cash' AS source, NULL::text AS note, at
            FROM (SELECT ${entryClientCodeSql("o.client_code", codes)} AS code, o.kind, o.kassa, o.created_at AS at,
                         ${cashDaySql("o.created_at")} AS day,
                         CASE WHEN o.currency = 'USD' THEN o.amount_minor
                              WHEN r.rate IS NOT NULL THEN (2 * o.amount_minor * 10000 + r.rate) / (2 * r.rate) END AS usd
                    FROM operations o
                   CROSS JOIN LATERAL (SELECT COALESCE(o.rate_e4, ${dayAverageRateSql("o")}) AS rate) r
                   WHERE o.client_code IS NOT NULL AND o.deleted_at IS NULL) named
           WHERE code IS NOT NULL AND usd IS NOT NULL
          UNION ALL
          SELECT client_code, paid_day, amount_minor, kassa, 'past', note, paid_day::timestamptz FROM past_payments`;
}

/**
 * The debts of the clients of the directory, by code: of `only` these, or of all of them. Read in one statement, so
 * the three parts of a debt are of one moment.
 */
export async function readDebts(db: Queryable, codes: ClientCodes, only?: readonly string[], today: string = cashDayOf(new Date())): Promise<Map<string, ClientDebt>> {
  const found = await db.query<{ code: string; opening: string; charged: string; paid: string; last_paid: string | null; last_trip: string | null; history_from: string | null }>(
    `SELECT cl.code, cl.opening_debt_minor AS opening, COALESCE(ch.minor, 0) AS charged, COALESCE(p.minor, 0) AS paid,
            to_char(p.last_day, 'YYYY-MM-DD') AS last_paid, to_char(ch.last_day, 'YYYY-MM-DD') AS last_trip,
            (SELECT to_char(LEAST((SELECT MIN(day) FROM (${CHARGES_SQL}) c), (SELECT MIN(day) FROM (${paymentsSql(codes)}) q)), 'YYYY-MM-DD')) AS history_from
       FROM clients cl
       LEFT JOIN (SELECT code, SUM(minor) AS minor, MAX(day) AS last_day FROM (${CHARGES_SQL}) charges GROUP BY code) ch ON ch.code = cl.code
       LEFT JOIN (SELECT code, SUM(minor) AS minor, MAX(day) FILTER (WHERE minor > 0) AS last_day FROM (${paymentsSql(codes)}) payments GROUP BY code) p ON p.code = cl.code
      WHERE $1::text[] IS NULL OR cl.code = ANY($1)`,
    [only ?? null],
  );
  const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  return new Map(
    found.rows.map((row) => {
      const openingDebtMinor = Number(row.opening);
      const chargedMinor = Number(row.charged);
      const paidMinor = Number(row.paid);
      const since = row.last_paid ?? `${(row.history_from ?? today).slice(0, 4)}-01-01`;
      return [
        row.code,
        {
          openingDebtMinor,
          chargedMinor,
          paidMinor,
          debtMinor: openingDebtMinor + chargedMinor - paidMinor,
          lastPaidDay: row.last_paid,
          lastTripDay: row.last_trip,
          daysUnpaid: Math.max(0, Math.round(dayNumber(today) - dayNumber(since))),
        },
      ];
    }),
  );
}

/** Someone the directory does not have owes nothing that is known here. */
export const NO_DEBT: ClientDebt = { openingDebtMinor: 0, chargedMinor: 0, paidMinor: 0, debtMinor: 0, lastPaidDay: null, lastTripDay: null, daysUnpaid: 0 };

/** One line of the card of a client: a trip that arrived (what it added to the debt) or a payment (what it took off). */
export type Movement = {
  /** YYYY-MM-DD: the day the trip arrived, or the day of the payment. */
  day: string;
  /** A trip that arrived; a payment; money given back to the client (a payment of less than nothing). */
  kind: "trip" | "payment" | "refund";
  /** The number of the trip. */
  tripNumber: number | null;
  /** What it added to the debt (a trip, money given back) or took off it (a payment): never less than nothing. */
  amountMinor: number;
  /** The cash desk that took a payment, where it is known. */
  kassa: string | null;
  /** A payment of the history (taken over from the card file) and not an entry of the cash book. */
  past: boolean;
  note: string | null;
  /** The debt after this line. */
  debtMinor: number;
};

export type Statement = {
  code: string;
  name: string;
  openingDebtMinor: number;
  movements: Movement[];
  debtMinor: number;
};

/**
 * The card of one client: what they owed at the start, and every trip and every payment since, oldest first, with the
 * debt after each. On one day the trips come before the payments, as the card file adds a month up. Undefined when
 * the directory has no such client. Read in one statement.
 */
export async function readStatement(db: Queryable, codes: ClientCodes, code: string): Promise<Statement | undefined> {
  const found = await db.query<{ name: string; opening: string; lines: Array<{ day: string; trip: number | null; minor: number; kassa: string | null; source: string | null; note: string | null }> | null }>(
    `SELECT cl.name, cl.opening_debt_minor AS opening,
            (SELECT json_agg(json_build_object('day', to_char(m.day, 'YYYY-MM-DD'), 'trip', m.trip, 'minor', m.minor, 'kassa', m.kassa, 'source', m.source, 'note', m.note)
                             ORDER BY m.day, m.turn, m.trip, m.at)
               FROM (SELECT day, number AS trip, minor, NULL::text AS kassa, NULL::text AS source, NULL::text AS note, 0 AS turn, NULL::timestamptz AS at
                       FROM (${CHARGES_SQL}) charges WHERE code = cl.code
                     UNION ALL
                     SELECT day, NULL, minor, kassa, source, note, 1, at FROM (${paymentsSql(codes)}) payments WHERE code = cl.code) m) AS lines
       FROM clients cl WHERE cl.code = $1`,
    [code],
  );
  const row = found.rows[0];
  if (!row) return undefined;
  const openingDebtMinor = Number(row.opening);
  let debtMinor = openingDebtMinor;
  const movements: Movement[] = (row.lines ?? []).map((line) => {
    const minor = Number(line.minor);
    const trip = line.trip !== null;
    debtMinor += trip ? minor : -minor;
    return {
      day: line.day,
      kind: trip ? "trip" : minor < 0 ? "refund" : "payment",
      tripNumber: line.trip,
      amountMinor: Math.abs(minor),
      kassa: line.kassa,
      past: line.source === "past",
      note: line.note,
      debtMinor,
    };
  });
  return { code, name: row.name, openingDebtMinor, movements, debtMinor };
}

/**
 * Everything the debts are worked out from, as it stands now: the clients of the directory, what each trip that has
 * arrived came to for each of them, and every payment. The report of a day (debt-report.ts) is made of it, for the
 * day asked for and for the days before: what somebody owed on a day is the opening, the trips up to it and the
 * payments up to it.
 */
export type DebtBook = {
  clients: Array<{ code: string; name: string; phone: string | null; openingMinor: number }>;
  /** A row to a client and a trip that has arrived; `day` is the day it arrived. */
  charges: Array<{ code: string; trip: number; day: string; minor: number }>;
  /** A row to a payment, oldest first; less than nothing is money given back to the client. */
  payments: Array<{ code: string; day: string; minor: number; kassa: string | null }>;
  /** When each trip was last marked as arrived or given another day of arrival, by its number; a trip of the history has no such moment. */
  arrivedAt: Map<number, Date>;
};

/** Reads the book. Call it in one transaction that sees one moment (REPEATABLE READ): it is three statements. */
export async function readDebtBook(db: Queryable, codes: ClientCodes): Promise<DebtBook> {
  const clients = await db.query<{ code: string; name: string; phone: string | null; opening: string }>(
    "SELECT code, name, phone, opening_debt_minor AS opening FROM clients ORDER BY code",
  );
  const charges = await db.query<{ code: string; number: number; day: string; minor: string }>(
    `SELECT code, number, to_char(day, 'YYYY-MM-DD') AS day, minor FROM (${CHARGES_SQL}) charges
      WHERE code IN (SELECT code FROM clients) ORDER BY day, number, code`,
  );
  const payments = await db.query<{ code: string; day: string; minor: string; kassa: string | null }>(
    `SELECT code, to_char(day, 'YYYY-MM-DD') AS day, minor, kassa FROM (${paymentsSql(codes)}) payments
      WHERE code IN (SELECT code FROM clients) ORDER BY day, at, code`,
  );
  const arrived = await db.query<{ number: number; at: Date }>(
    `SELECT t.number, MAX(h.changed_at) AS at FROM trip_changes h JOIN trips t ON t.id = h.trip_id
      WHERE t.deleted_at IS NULL AND t.status = 'arrived'
        AND ((h.action = 'status' AND h.state_after->>'status' = 'arrived')
          OR (h.action = 'edit' AND h.state_before->>'arrivalDay' IS DISTINCT FROM h.state_after->>'arrivalDay'))
      GROUP BY t.number`,
  );
  return {
    clients: clients.rows.map((row) => ({ code: row.code, name: row.name, phone: row.phone, openingMinor: Number(row.opening) })),
    charges: charges.rows.map((row) => ({ code: row.code, trip: row.number, day: row.day, minor: Number(row.minor) })),
    payments: payments.rows.map((row) => ({ code: row.code, day: row.day, minor: Number(row.minor), kassa: row.kassa })),
    arrivedAt: new Map(arrived.rows.map((row) => [row.number, row.at])),
  };
}

/** A month of the control sheet: what all the clients owed when it began, what arrived, what was paid, what they owed when it ended. */
export type ControlMonth = { month: string; openingMinor: number; chargedMinor: number; paidMinor: number; closingMinor: number };

/**
 * The control sheet of a year, as the card file has it: month by month, what all the clients of the directory owed
 * at the start, what the trips that arrived in the month added, what was paid in it, and what was owed at the end. The
 * months run to the last one that has anything in it. What happened before the year is in the opening of January.
 */
export async function readControl(db: Queryable, codes: ClientCodes, year: number): Promise<ControlMonth[]> {
  const found = await db.query<{ opening: string; months: Array<{ month: string; charged: number; paid: number }> | null }>(
    `SELECT (SELECT COALESCE(SUM(opening_debt_minor), 0) FROM clients) AS opening,
            (SELECT json_agg(json_build_object('month', month, 'charged', charged, 'paid', paid) ORDER BY month)
               FROM (SELECT month, SUM(charged) AS charged, SUM(paid) AS paid
                       FROM (SELECT to_char(day, 'YYYY-MM') AS month, minor AS charged, 0 AS paid FROM (${CHARGES_SQL}) charges WHERE code IN (SELECT code FROM clients)
                             UNION ALL
                             SELECT to_char(day, 'YYYY-MM'), 0, minor FROM (${paymentsSql(codes)}) payments WHERE code IN (SELECT code FROM clients)) moves
                      GROUP BY month) by_month) AS months`,
  );
  const months = found.rows[0]?.months ?? [];
  let debt = Number(found.rows[0]?.opening ?? 0);
  const first = `${year}-01`;
  for (const item of months) if (item.month < first) debt += Number(item.charged) - Number(item.paid);
  const ofYear = months.filter((item) => item.month.startsWith(`${year}-`));
  const last = ofYear.length > 0 ? Number(ofYear[ofYear.length - 1]!.month.slice(5)) : 0;
  const control: ControlMonth[] = [];
  for (let number = 1; number <= last; number++) {
    const month = `${year}-${String(number).padStart(2, "0")}`;
    const item = ofYear.find((candidate) => candidate.month === month);
    const chargedMinor = Number(item?.charged ?? 0);
    const paidMinor = Number(item?.paid ?? 0);
    control.push({ month, openingMinor: debt, chargedMinor, paidMinor, closingMinor: debt + chargedMinor - paidMinor });
    debt += chargedMinor - paidMinor;
  }
  return control;
}
