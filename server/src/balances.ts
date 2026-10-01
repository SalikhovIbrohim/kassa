import type pg from "pg";
import { CURRENCIES, type Currency } from "./money.js";

export type Balance = { currency: Currency; amountMinor: number };

/** A pool, or one connection checked out of it (inside a transaction). */
export type Queryable = Pick<pg.Pool, "query">;

/**
 * Opening balance plus incomes minus expenses, per currency, always all currencies, plus what counting
 * the cash found at the end of shifts (a shortage lowers it, a surplus raises it: the books then say what
 * is really in the cash desk). A deleted operation counts for nothing.
 */
export async function getBalances(db: Queryable): Promise<Balance[]> {
  const result = await db.query<{ currency: Currency; amount_minor: string }>(
    `SELECT c.currency,
            COALESCE(o.amount_minor, 0)
              + COALESCE(SUM(CASE op.kind WHEN 'income' THEN op.amount_minor ELSE -op.amount_minor END), 0)
              + COALESCE((SELECT SUM(sb.difference_minor) FROM shift_balances sb WHERE sb.currency = c.currency), 0)
              AS amount_minor
       FROM unnest($1::text[]) AS c(currency)
       LEFT JOIN opening_balances o ON o.currency = c.currency
       LEFT JOIN operations op ON op.currency = c.currency AND op.deleted_at IS NULL
      GROUP BY c.currency, o.amount_minor
      ORDER BY c.currency`,
    [CURRENCIES],
  );
  // bigint comes back as a string. Single amounts are capped (see MAX_AMOUNT_MINOR) so that
  // sums stay exact as numbers for any realistic number of operations.
  return result.rows.map((row) => ({ currency: row.currency, amountMinor: Number(row.amount_minor) }));
}
