/**
 * The cash desk keeps Moscow time (UTC+3 all year round, there is no daylight saving).
 * Instants are stored in UTC; a "day" for people is a Moscow calendar day, written
 * YYYY-MM-DD. These helpers convert between the two.
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Moscow calendar day an instant falls on: 2026-03-04T21:00:00Z -> "2026-03-05". */
export function cashDayOf(instant: Date): string {
  return new Date(instant.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant a Moscow day begins: "2026-03-05" -> 2026-03-04T21:00:00Z. */
export function cashDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - MOSCOW_OFFSET_MS);
}

/** The instant the next Moscow day begins, i.e. the end of `day`, not included. */
export function cashDayEnd(day: string): Date {
  return new Date(cashDayStart(day).getTime() + DAY_MS);
}
