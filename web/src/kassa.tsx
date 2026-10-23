import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Currency } from "./money";

/** The cash desks of the business: Moscow keeps rubles and dollars, Andijan dollars only. */
export type Kassa = "moscow" | "andijan";
export const KASSAS: readonly Kassa[] = ["moscow", "andijan"];
export const KASSA_LABEL: Record<Kassa, string> = { moscow: "Москва", andijan: "Андижан" };
/** The short mark of a desk on an entry, when the journal shows both. */
export const KASSA_SHORT: Record<Kassa, string> = { moscow: "МСК", andijan: "АНД" };
export const KASSA_CURRENCIES: Record<Kassa, readonly Currency[]> = { moscow: ["RUB", "USD"], andijan: ["USD"] };

/** What the journal, the totals and the counts show: one desk, or both («Обе кассы»), for a person of everywhere. */
export type Scope = Kassa | "both";

const KEY = "kassa.kassa";
const SCOPE_KEY = "kassa.scope";

type KassaState = {
  /** The cash desk the forms write to, and whose balances they show. */
  kassa: Kassa;
  /** A person of everywhere chooses; a person of a city works in that city's desk only. */
  choosable: boolean;
  setKassa: (kassa: Kassa) => void;
  /** The desk (or both) of the journal, the totals and the counts. A person of a city sees their own desk. */
  scope: Scope;
  setScope: (scope: Scope) => void;
};

const KassaContext = createContext<KassaState>({ kassa: "moscow", choosable: false, setKassa: () => {}, scope: "moscow", setScope: () => {} });

function kept<T extends string>(key: string, allowed: readonly T[], otherwise: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : otherwise;
  } catch {
    return otherwise;
  }
}

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept: the next visit starts from the default
  }
}

/** The kassa an API call asks for: a scope of both asks for none, which the server answers with both. */
export const scopeKassa = (scope: Scope): Kassa | undefined => (scope === "both" ? undefined : scope);

/** The currencies a scope shows: both desks together keep rubles and dollars. */
export const scopeCurrencies = (scope: Scope): readonly Currency[] => (scope === "both" ? ["RUB", "USD"] : KASSA_CURRENCIES[scope]);

/**
 * The cash desk of the signed-in person: their city's, or for a person of everywhere the one they chose last on this
 * device (Moscow at first), and what they look at in the journal (both desks at first).
 */
export function KassaProvider({ city, children }: { city: Kassa | null | undefined; children: ReactNode }) {
  const [chosen, setChosen] = useState<Kassa>(() => kept(KEY, KASSAS, "moscow"));
  const [chosenScope, setChosenScope] = useState<Scope>(() => kept<Scope>(SCOPE_KEY, ["both", ...KASSAS], "both"));
  const setKassa = useCallback((kassa: Kassa) => {
    setChosen(kassa);
    keep(KEY, kassa);
  }, []);
  const setScope = useCallback((scope: Scope) => {
    setChosenScope(scope);
    keep(SCOPE_KEY, scope);
  }, []);
  const value = useMemo<KassaState>(
    () =>
      city
        ? { kassa: city, choosable: false, setKassa: () => {}, scope: city, setScope: () => {} }
        : { kassa: chosen, choosable: true, setKassa, scope: chosenScope, setScope },
    [city, chosen, chosenScope, setKassa, setScope],
  );
  return <KassaContext.Provider value={value}>{children}</KassaContext.Provider>;
}

export function useKassa(): KassaState {
  return useContext(KassaContext);
}
