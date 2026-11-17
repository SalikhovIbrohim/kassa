import type { Queryable } from "./balances.js";
import type { ClientCodes } from "./clients.js";
import { dayAverageRateSql } from "./ledger.js";

/**
 * What a client owes, in cents of a dollar. Nothing of it is stored: it is worked out, every time it is asked for,
 * from the trips (what the cargo of the client on the trucks that have arrived comes to) and from the cash book (what
 * the entries that name the client took in and gave back). So the cash desk and the trips can never say two different
 * debts of one client.
 */
export type ClientDebt = {
  /** What the client owed on the day the trips began to be kept here; less than nothing is money paid ahead. */
  openingDebtMinor: number;
  /** What the cargo of the client comes to on the trips that have arrived. */
  chargedMinor: number;
  /** What the client paid into the cash desks, less what was given back to them. */
  paidMinor: number;
  /** Opening + charged - paid: more than nothing, the client owes; less, they have paid ahead. */
  debtMinor: number;
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
 * SQL for what the clients paid, by code: every entry of the cash desk that names a client and is not deleted. An
 * income is a payment, an expense is money given back to the client. Dollars are what they are; rubles are counted at
 * the rate of the entry (for an expense without one, the average of its day), as the journal shows them, and an entry
 * that has no rate at all yet is left out until it has one.
 */
function paidSql(codes: ClientCodes): string {
  return `SELECT code, SUM(CASE WHEN kind = 'income' THEN usd ELSE -usd END) AS minor
            FROM (SELECT ${entryClientCodeSql("o.client_code", codes)} AS code, o.kind,
                         CASE WHEN o.currency = 'USD' THEN o.amount_minor
                              WHEN r.rate IS NOT NULL THEN (2 * o.amount_minor * 10000 + r.rate) / (2 * r.rate) END AS usd
                    FROM operations o
                   CROSS JOIN LATERAL (SELECT COALESCE(o.rate_e4, ${dayAverageRateSql("o")}) AS rate) r
                   WHERE o.client_code IS NOT NULL AND o.deleted_at IS NULL) named
           WHERE code IS NOT NULL AND usd IS NOT NULL
           GROUP BY code`;
}

/** SQL for what the clients owe for the trips that have arrived, by code: each trip rounded by itself, then added up. */
const CHARGED_SQL = `SELECT client_code AS code, SUM(minor) AS minor
            FROM (SELECT c.client_code, ${centsOfMicroSql("SUM(c.weight_g::numeric * c.price_milli)")} AS minor
                    FROM trip_cargo c JOIN trips t ON t.id = c.trip_id
                   WHERE c.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status = 'arrived'
                   GROUP BY c.client_code, c.trip_id) per_trip
           GROUP BY client_code`;

/**
 * The debts of the clients of the directory, by code: of `only` these, or of all of them. Read in one statement, so
 * the three parts of a debt are of one moment.
 */
export async function readDebts(db: Queryable, codes: ClientCodes, only?: readonly string[]): Promise<Map<string, ClientDebt>> {
  const found = await db.query<{ code: string; opening: string; charged: string; paid: string }>(
    `SELECT cl.code, cl.opening_debt_minor AS opening, COALESCE(ch.minor, 0) AS charged, COALESCE(p.minor, 0) AS paid
       FROM clients cl
       LEFT JOIN (${CHARGED_SQL}) ch ON ch.code = cl.code
       LEFT JOIN (${paidSql(codes)}) p ON p.code = cl.code
      WHERE $1::text[] IS NULL OR cl.code = ANY($1)`,
    [only ?? null],
  );
  return new Map(
    found.rows.map((row) => {
      const openingDebtMinor = Number(row.opening);
      const chargedMinor = Number(row.charged);
      const paidMinor = Number(row.paid);
      return [row.code, { openingDebtMinor, chargedMinor, paidMinor, debtMinor: openingDebtMinor + chargedMinor - paidMinor }];
    }),
  );
}

/** Someone the directory does not have owes nothing that is known here. */
export const NO_DEBT: ClientDebt = { openingDebtMinor: 0, chargedMinor: 0, paidMinor: 0, debtMinor: 0 };
