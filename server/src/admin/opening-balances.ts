import type pg from "pg";
import { AdminError } from "./users.js";
import { isCurrency, parseAmount } from "../money.js";

/**
 * Sets the amount a currency's balance starts from, replacing an earlier value.
 * `amount` is what the developer types, e.g. "1000.50".
 */
export async function setOpeningBalance(
  pool: pg.Pool,
  currency: string,
  amount: string,
): Promise<number> {
  const code = currency.trim().toUpperCase();
  if (!isCurrency(code)) {
    throw new AdminError(`Currency must be RUB or USD, got "${currency}"`);
  }
  const minor = parseAmount(amount);
  if (minor === null) {
    throw new AdminError(`Amount must look like 1000 or 1000.50, got "${amount}"`);
  }
  await pool.query(
    `INSERT INTO opening_balances (currency, amount_minor, set_at) VALUES ($1, $2, now())
     ON CONFLICT (currency) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, set_at = now()`,
    [code, minor],
  );
  return minor;
}
