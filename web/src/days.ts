/**
 * The cash desk keeps Moscow time, whatever time zone the phone is set to. A "day" is a
 * Moscow calendar day written YYYY-MM-DD, the way the server takes it.
 * Moscow is UTC+3 all year round, so the conversion is a plain offset.
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export function moscowToday(now: Date = new Date()): string {
  return new Date(now.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
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

/** The first and the last Moscow day of a quick choice of period, `today` being the Moscow day it is now. */
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
