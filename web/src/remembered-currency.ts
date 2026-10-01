import type { Currency } from "./money";

const KEY = "kassa.currency";

/**
 * The currency of the last entry, so that a form opened without a connection starts with it: a
 * cashier who works in dollars must not find rubles there and enter 100 as rubles.
 */
export function rememberCurrency(currency: Currency) {
  try {
    localStorage.setItem(KEY, currency);
  } catch {
    // not remembered; the form then starts with the server's idea of it, or rubles
  }
}

export function rememberedCurrency(): Currency | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "RUB" || value === "USD" ? value : null;
  } catch {
    return null;
  }
}
