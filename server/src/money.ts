export const CURRENCIES = ["RUB", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Largest single amount accepted, in minor units (100 million in whole currency).
 * Chosen so that sums stay exact: a balance would need about 900,000 operations of this
 * size to pass the largest integer a JavaScript number holds exactly.
 */
export const MAX_AMOUNT_MINOR = 10_000_000_000;

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

/**
 * Turns what a person types ("1000", "1000.5", "1000,50") into whole minor units.
 * Works on the digits, never multiplies a float. Returns null for anything else.
 */
export function parseAmount(text: string): number | null {
  const match = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + fraction;
  return minor > MAX_AMOUNT_MINOR ? null : minor;
}

/** 100050 -> "1000.50". */
export function formatAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}
