import type pg from "pg";
import { KASSA_CURRENCIES, type Kassa } from "./kassa.js";
import { CURRENCIES, type Currency } from "./money.js";

export type Balance = { currency: Currency; amountMinor: number };

/** A pool, or one connection checked out of it (inside a transaction). */
export type Queryable = Pick<pg.Pool, "query">;

/**
 * Opening balance plus incomes minus expenses, per currency, plus what the reconciliations found when the cash was
 * counted (a shortage lowers it, a surplus raises it: the books then say what is really in the cash desk). A deleted
 * operation counts for nothing. For one cash desk, its currencies; without one, both desks added up, every currency.
 */
export async function getBalances(db: Queryable, kassa?: Kassa): Promise<Balance[]> {
  const result = await db.query<{ currency: Currency; amount_minor: string }>(
    `SELECT c.currency,
            COALESCE((SELECT SUM(o.amount_minor) FROM opening_balances o WHERE o.currency = c.currency AND ($2::text IS NULL OR o.kassa = $2)), 0)
              + COALESCE((SELECT SUM(CASE op.kind WHEN 'income' THEN op.amount_minor ELSE -op.amount_minor END)
                            FROM operations op
                           WHERE op.currency = c.currency AND op.deleted_at IS NULL AND ($2::text IS NULL OR op.kassa = $2)), 0)
              + COALESCE((SELECT SUM(rb.difference_minor) FROM reconciliation_balances rb JOIN reconciliations r ON r.id = rb.reconciliation_id
                           WHERE rb.currency = c.currency AND ($2::text IS NULL OR r.kassa = $2)), 0)
              AS amount_minor
       FROM unnest($1::text[]) AS c(currency)
      ORDER BY c.currency`,
    [kassa ? KASSA_CURRENCIES[kassa] : CURRENCIES, kassa ?? null],
  );
  // bigint comes back as a string. Single amounts are capped (see MAX_AMOUNT_MINOR) so that
  // sums stay exact as numbers for any realistic number of operations.
  return result.rows.map((row) => ({ currency: row.currency, amountMinor: Number(row.amount_minor) }));
}
