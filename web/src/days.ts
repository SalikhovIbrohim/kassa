/**
 * The cash desk keeps Moscow time, whatever time zone the phone is set to. A "day" of the cash desk runs from 03:00 to
 * 03:00 Moscow time (the cashiers work until midnight and a little after, and there is no shift to close: the day turns
 * over by itself at three in the morning). It is written YYYY-MM-DD, the date it begins on, the way the server takes it.
 * Moscow is UTC+3 all year round, so the conversion is a plain offset.
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
/** The hour of Moscow time at which a day of the cash desk begins. */
const DAY_STARTS_AT_MS = 3 * 60 * 60 * 1000;

/** The day of the cash desk it is at `now`: at 01:00 on the 6th in Moscow it is still the 5th. */
export function cashDayToday(now: Date = new Date()): string {
  return new Date(now.getTime() + MOSCOW_OFFSET_MS - DAY_STARTS_AT_MS).toISOString().slice(0, 10);
}

export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "2026-03-05" -> "05.03.2026". */
export function formatDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** "11:30" in Moscow time. */
export function formatMoscowClock(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "05.03 11:30" in Moscow time. */
export function formatMoscowShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${at("day")}.${at("month")} ${at("hour")}:${at("minute")}`;
}

export type PeriodPreset = "today" | "yesterday" | "week" | "month";

/** The first and the last day of the cash desk of a quick choice of period, `today` being the day it is now. */
export function presetPeriod(preset: PeriodPreset, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = shiftDay(today, -1);
      return { from: day, to: day };
    }
    case "week":
      // Seven days, today included.
      return { from: shiftDay(today, -6), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}
