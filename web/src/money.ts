export type Currency = "RUB" | "USD";

export const CURRENCIES: readonly Currency[] = ["RUB", "USD"];

export const CURRENCY_NAME: Record<Currency, string> = {
  RUB: "Рубли",
  USD: "Доллары",
};

/** Largest single amount the server accepts, in minor units. */
const MAX_AMOUNT_MINOR = 10_000_000_000;

/**
 * Turns what a person types ("1500", "1 500,50", "1500.5") into whole minor units
 * (kopecks, cents). Works on the digits, never multiplies a float. Null when it is
 * not a positive amount with at most two decimals.
 */
export function parseAmountInput(text: string): number | null {
  const cleaned = text.replace(/[\s ]/g, "");
  const match = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return minor >= 1 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

/**
 * The rate typed as "79", "78,4" or "78.2345" (rubles for one dollar) into the whole number the server keeps: times 10 000.
 * Null when it is not a rate from 1 to 1000 with at most four decimals.
 */
export function parseRateInput(text: string): number | null {
  const cleaned = text.replace(/[\s ]/g, "");
  const match = /^(\d{1,4})(?:[.,](\d{1,4}))?$/.exec(cleaned);
  if (!match) return null;
  const rateE4 = Number(match[1]) * 10_000 + Number((match[2] ?? "").padEnd(4, "0"));
  return rateE4 >= 10_000 && rateE4 <= 10_000_000 ? rateE4 : null;
}

/** 784000 -> "78,4": what a person would type, to prefill the field. */
export function formatRateInput(rateE4: number): string {
  const whole = Math.floor(rateE4 / 10_000);
  const fraction = String(rateE4 % 10_000).padStart(4, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole},${fraction}`;
}

/** 784000 -> "78,40": a rate for reading, with at least two decimals. */
export function formatRate(rateE4: number): string {
  const whole = Math.floor(rateE4 / 10_000);
  const fraction = String(rateE4 % 10_000).padStart(4, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole},${fraction}`;
}

/** What was counted in the cash desk: like an amount, but nothing at all is a count too ("0"). Null when it is not one. */
export function parseCountInput(text: string): number | null {
  const cleaned = text.replace(/[\s ]/g, "");
  if (cleaned === "") return null;
  const match = /^(\d{1,13})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** A signed amount for a difference: "+20,00 ₽", "−20,00 ₽"; nothing found is just "0,00 ₽". */
export function formatDifference(minor: number, currency: Currency): string {
  if (minor === 0) return formatMoney(0, currency);
  return `${minor > 0 ? "+" : "−"}${formatMoney(Math.abs(minor), currency)}`;
}

/** 150050 -> "1500,50", 150000 -> "1500": what a person would type, to prefill a field. */
export function formatAmountInput(minor: number): string {
  const whole = Math.floor(minor / 100);
  const fraction = minor % 100;
  return fraction === 0 ? String(whole) : `${whole},${String(fraction).padStart(2, "0")}`;
}

export function formatMoney(minor: number, currency: Currency): string {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(minor / 100);
}

/** "05.03.2026, 11:30" in Moscow time, whatever time zone the phone is set to. */
export function formatMoscowTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
