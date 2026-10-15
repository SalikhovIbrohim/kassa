import type { Currency } from "./money.js";

/** The cash desks of the business: Moscow keeps rubles and dollars, Andijan dollars only. */
export const KASSAS = ["moscow", "andijan"] as const;
export type Kassa = (typeof KASSAS)[number];

export const KASSA_CURRENCIES: Record<Kassa, readonly Currency[]> = {
  moscow: ["RUB", "USD"],
  andijan: ["USD"],
};

export const KASSA_LABEL: Record<Kassa, string> = { moscow: "Москва", andijan: "Андижан" };

export const kassaProperty = { type: "string", enum: [...KASSAS] } as const;

export function isKassa(value: unknown): value is Kassa {
  return typeof value === "string" && (KASSAS as readonly string[]).includes(value);
}

/**
 * Whether a person of `city` works in `kassa`: the city a person has in «Люди» is the cash desk they work in, and a
 * person of everywhere (no city: the admin, the owner) sees both.
 */
export function mayUseKassa(city: Kassa | null, kassa: Kassa): boolean {
  return city === null || city === kassa;
}

/** The cash desk a person works in when they do not say: their city's, or Moscow's for a person of everywhere. */
export function defaultKassa(city: Kassa | null): Kassa {
  return city ?? "moscow";
}
