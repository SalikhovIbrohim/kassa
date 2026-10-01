/** The rate the tests count a ruble income at: 79 rubles for a dollar (times 10 000). */
export const TEST_RATE_E4 = 790_000;

/**
 * An income in rubles must name its rate: the entry as it was written, with the rate of the tests added when
 * it is a ruble income that says none. Dollars have no rate, so those stay as they are.
 */
export function withRate<T extends { type: string; currency?: unknown; rateE4?: number }>(entry: T): T {
  if (entry.type === "income" && entry.currency === "RUB" && entry.rateE4 === undefined) {
    return { ...entry, rateE4: TEST_RATE_E4 };
  }
  return entry;
}
