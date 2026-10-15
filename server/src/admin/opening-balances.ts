import type pg from "pg";
import { AdminError } from "./users.js";
import { isCurrency, parseAmount } from "../money.js";
import { KASSA_CURRENCIES, type Kassa } from "../kassa.js";

/**
 * Sets the amount a currency's balance starts from, replacing an earlier value.
 * `amount` is what the developer types, e.g. "1000.50".
 */
export async function setOpeningBalance(
  pool: pg.Pool,
  currency: string,
  amount: string,
  kassa: Kassa = "moscow",
): Promise<number> {
  const code = currency.trim().toUpperCase();
  if (!isCurrency(code)) {
    throw new AdminError(`Currency must be RUB or USD, got "${currency}"`);
  }
  if (!KASSA_CURRENCIES[kassa].includes(code)) {
    throw new AdminError(`The cash desk ${kassa} does not keep ${code}: it keeps ${KASSA_CURRENCIES[kassa].join(" and ")}`);
  }
  const minor = parseAmount(amount);
  if (minor === null) {
    throw new AdminError(`Amount must look like 1000 or 1000.50, got "${amount}"`);
  }
  await pool.query(
    `INSERT INTO opening_balances (kassa, currency, amount_minor, set_at) VALUES ($3, $1, $2, now())
     ON CONFLICT (kassa, currency) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, set_at = now()`,
    [code, minor, kassa],
  );
  return minor;
}
