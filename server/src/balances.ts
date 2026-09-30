import type pg from "pg";
import { CURRENCIES, type Currency } from "./money.js";

export type Balance = { currency: Currency; amountMinor: number };

/** Opening balance plus every income, one balance per currency, always all currencies. */
export async function getBalances(pool: pg.Pool): Promise<Balance[]> {
  const result = await pool.query<{ currency: Currency; amount_minor: string }>(
    `SELECT c.currency,
            COALESCE(o.amount_minor, 0) + COALESCE(SUM(op.amount_minor), 0) AS amount_minor
       FROM unnest($1::text[]) AS c(currency)
       LEFT JOIN opening_balances o ON o.currency = c.currency
       LEFT JOIN operations op ON op.currency = c.currency
      GROUP BY c.currency, o.amount_minor
      ORDER BY c.currency`,
    [CURRENCIES],
  );
  // bigint comes back as a string. Single amounts are capped (see MAX_AMOUNT_MINOR) so that
  // sums stay exact as numbers for any realistic number of operations.
  return result.rows.map((row) => ({ currency: row.currency, amountMinor: Number(row.amount_minor) }));
}
