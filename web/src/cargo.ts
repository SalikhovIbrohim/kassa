import { formatMoney } from "./money";

/**
 * The numbers of the cargo, as the server keeps them: a weight in grams, the price of a kilogram in thousandths of a
 * dollar, money in cents. Whole numbers all the way; what a person types is read by its digits, never as a float.
 */

/** A thousand tonnes on one line, a thousand dollars for a kilogram: what the server takes at most. */
const MAX_WEIGHT_G = 1_000_000_000;
const MAX_PRICE_MILLI = 1_000_000;

/** "1 075", "547,02", "3686.5" (kilograms, at most three decimals) into grams; null when it is not a weight above nothing. */
export function parseWeightInput(text: string): number | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(text.replace(/[\s ]/g, ""));
  if (!match) return null;
  const grams = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return grams >= 1 && grams <= MAX_WEIGHT_G ? grams : null;
}

/** "1,55", "1.5", "2" (dollars for a kilogram, at most three decimals) into thousandths; nothing is a price too (0). */
export function parsePriceInput(text: string): number | null {
  const match = /^(\d{1,4})(?:[.,](\d{1,3}))?$/.exec(text.replace(/[\s ]/g, ""));
  if (!match) return null;
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return milli <= MAX_PRICE_MILLI ? milli : null;
}

/**
 * A count of bags or pieces: a whole number, or nothing at all (the field left empty). `undefined` when what was typed
 * is neither.
 */
export function parseCount(text: string, max = 1_000_000_000): number | null | undefined {
  const cleaned = text.replace(/[\s ]/g, "");
  if (cleaned === "") return null;
  if (!/^\d{1,10}$/.test(cleaned)) return undefined;
  const count = Number(cleaned);
  return count <= max ? count : undefined;
}

/**
 * What a client owed at the start: an amount that may be less than nothing ("-50" is fifty dollars paid ahead), in
 * cents. Nothing typed is nothing owed. Null when it is not an amount.
 */
export function parseDebtInput(text: string): number | null {
  const cleaned = text.replace(/[\s ]/g, "").replace("−", "-");
  if (cleaned === "") return 0;
  const match = /^(-?)(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -minor : minor;
}

const decimals = (whole: number, fraction: number, places: number) => {
  const tail = String(fraction).padStart(places, "0").replace(/0+$/, "");
  return tail === "" ? String(whole) : `${whole},${tail}`;
};

/** 1550 -> "1,55", 1500 -> "1,5": the price of a kilogram as a person would type it. */
export const formatPrice = (milli: number) => decimals(Math.floor(milli / 1000), milli % 1000, 3);

/** 547020 -> "547,02", 1075000 -> "1075": a weight as a person would type it, to prefill a field. */
export const formatWeightInput = (grams: number) => decimals(Math.floor(grams / 1000), grams % 1000, 3);

/** 3686500 -> "3 686,5": a weight in kilograms for reading. */
export function formatWeight(grams: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(grams / 1000);
}

/** 36000 -> "36 000": a count for reading; nothing for none. */
export const formatCount = (count: number | null) => (count === null ? "" : new Intl.NumberFormat("ru-RU").format(count));

/** -5000 -> "-50", 120050 -> "1200,50": what a client owed at the start, as it would be typed. */
export function formatDebtInput(minor: number): string {
  const absolute = Math.abs(minor);
  const text = absolute % 100 === 0 ? String(absolute / 100) : `${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
  return minor < 0 ? `-${text}` : text;
}

/**
 * What a weight at a price comes to, in cents, rounded half up: grams times thousandths of a dollar are millionths of
 * a dollar. The same sum the server makes.
 */
export const cargoAmountMinor = (weightG: number, priceMilli: number) => Math.floor((weightG * priceMilli + 5000) / 10000);

/** Cents as dollars for reading: 166625 -> "1 666,25 $". */
export const formatUsd = (minor: number) => formatMoney(minor, "USD");

/**
 * What a client owes, in words: more than nothing is a debt, less is money paid ahead, nothing is nothing.
 * `tone` is the color it is said in.
 */
export function debtWords(debtMinor: number): { text: string; tone: "debt" | "ahead" | "even" } {
  if (debtMinor > 0) return { text: `долг ${formatUsd(debtMinor)}`, tone: "debt" };
  if (debtMinor < 0) return { text: `предоплата ${formatUsd(-debtMinor)}`, tone: "ahead" };
  return { text: "долга нет", tone: "even" };
}

export type TripStatus = "loading" | "in_transit" | "arrived";

export const TRIP_STATUS_LABEL: Record<TripStatus, string> = { loading: "Грузится", in_transit: "В пути", arrived: "Прибыл" };

/** "2026-08-16" -> "16.08.2026"; nothing for no day. */
export const formatTripDay = (day: string | null) => (day ? day.split("-").reverse().join(".") : "");

/** The calendar day of Moscow today, as YYYY-MM-DD: the day a form offers for a departure or an arrival. */
export function moscowToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The front part of the truck and the back one, as the waybills of the business call them. */
export const TRUCK_PART_LABEL: Record<"head" | "trailer", string> = { head: "Голова", trailer: "Прицеп" };

/** Where a line lies on the truck, as the waybill writes it: «Голова 3», «Прицеп 5»; nothing for a line that says no part. */
export const formatPlace = (part: "head" | "trailer" | null, place: number | null) => (part ? `${TRUCK_PART_LABEL[part]}${place === null ? "" : ` ${place}`}` : "");

/** "2026-11-04" -> "04.11": the day a warehouse took the cargo in, short, for a column of a table. */
export const formatShortDay = (day: string | null) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : "");

/** "2026-01" -> "Январь": a month of the control sheet. */
export function formatMonth(month: string): string {
  const names = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  return names[Number(month.slice(5, 7)) - 1] ?? month;
}
