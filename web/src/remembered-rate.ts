import { moscowToday } from "./days";

const KEY = "kassa.rate";

/**
 * The rate of the last entry, for today only: the rate is much the same all day, so a form starts with it (the cashier
 * sees it and changes it), and not the next day, when yesterday's rate would be wrong without anyone noticing.
 */
export function rememberRate(rateE4: number, now: Date = new Date()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ rateE4, day: moscowToday(now) }));
  } catch {
    // not remembered; the form then starts empty
  }
}

export function rememberedRate(now: Date = new Date()): number | null {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "null") as { rateE4?: unknown; day?: unknown } | null;
    if (kept && typeof kept.rateE4 === "number" && kept.day === moscowToday(now)) return kept.rateE4;
  } catch {
    // nothing remembered
  }
  return null;
}
