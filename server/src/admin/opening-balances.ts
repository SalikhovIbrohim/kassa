import type pg from "pg";
import { AdminError } from "./users.js";
import { isCurrency, parseAmount } from "../money.js";
import { DEFAULT_KASSAS, type Kassa, type Kassas } from "../kassa.js";

/**
 * Sets the amount a currency's balance starts from, replacing an earlier value.
 * `amount` is what the developer types, e.g. "1000.50". The cash desk is the main one unless said.
 */
export async function setOpeningBalance(
  pool: pg.Pool,
  currency: string,
  amount: string,
  kassa?: Kassa,
  kassas: Kassas = DEFAULT_KASSAS,
): Promise<number> {
  const desk = kassa ?? kassas.primary;
  const code = currency.trim().toUpperCase();
  if (!isCurrency(code)) {
    throw new AdminError(`Currency must be RUB or USD, got "${currency}"`);
  }
  if (!kassas.currenciesOf(desk).includes(code)) {
    throw new AdminError(`The cash desk ${desk} does not keep ${code}: it keeps ${kassas.currenciesOf(desk).join(" and ")}`);
  }
  const minor = parseAmount(amount);
  if (minor === null) {
    throw new AdminError(`Amount must look like 1000 or 1000.50, got "${amount}"`);
  }
  await pool.query(
    `INSERT INTO opening_balances (kassa, currency, amount_minor, set_at) VALUES ($3, $1, $2, now())
     ON CONFLICT (kassa, currency) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, set_at = now()`,
    [code, minor, desk],
  );
  return minor;
}
