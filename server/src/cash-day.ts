/**
 * The cash desk keeps Moscow time (UTC+3 all year round, there is no daylight saving). Instants are stored in UTC.
 *
 * A "day" of the cash desk is not the calendar day of Moscow: it runs from 03:00 to 03:00, because the cashiers work
 * until midnight and sometimes a little after, and what is entered at 01:00 belongs to the day that is ending. There is
 * no shift to open or close: at three in the morning the day turns over by itself. A day is written YYYY-MM-DD, the
 * date it begins on. These helpers convert between the two.
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
/** The hour of Moscow time at which a day of the cash desk begins. */
const DAY_STARTS_AT_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Added to an instant, it gives a clock that reads 00:00 exactly when a day of the cash desk begins. */
const DAY_SHIFT_MS = MOSCOW_OFFSET_MS - DAY_STARTS_AT_MS;

/** The day of the cash desk an instant falls on: 2026-03-05T00:30:00+03:00 (01:00 in the night) is still "2026-03-04". */
export function cashDayOf(instant: Date): string {
  return new Date(instant.getTime() + DAY_SHIFT_MS).toISOString().slice(0, 10);
}

/** The instant a day of the cash desk begins: "2026-03-05" is 2026-03-05 03:00 Moscow time. */
export function cashDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_SHIFT_MS);
}

/** The instant the next day begins, i.e. the end of `day`, not included. */
export function cashDayEnd(day: string): Date {
  return new Date(cashDayStart(day).getTime() + DAY_MS);
}

/** SQL for the instant the day of the cash desk begins that the timestamptz expression `column` falls on (the same as `cashDayStart(cashDayOf(...))`). */
export function cashDayStartSql(column: string): string {
  const shift = `make_interval(secs => ${DAY_SHIFT_MS / 1000})`;
  return `((date_trunc('day', (${column} AT TIME ZONE 'UTC') + ${shift}) - ${shift}) AT TIME ZONE 'UTC')`;
}
