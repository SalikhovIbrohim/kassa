import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Currency } from "./money";

/** The cash desks of the business: Moscow keeps rubles and dollars, Andijan dollars only. */
export type Kassa = "moscow" | "andijan";
export const KASSAS: readonly Kassa[] = ["moscow", "andijan"];
export const KASSA_LABEL: Record<Kassa, string> = { moscow: "Москва", andijan: "Андижан" };
export const KASSA_CURRENCIES: Record<Kassa, readonly Currency[]> = { moscow: ["RUB", "USD"], andijan: ["USD"] };

const KEY = "kassa.kassa";

type KassaState = {
  /** The cash desk the screens show and the entries go to. */
  kassa: Kassa;
  /** A person of everywhere (no city) chooses; a person of a city works in that city's desk only. */
  choosable: boolean;
  setKassa: (kassa: Kassa) => void;
};

const KassaContext = createContext<KassaState>({ kassa: "moscow", choosable: false, setKassa: () => {} });

function kept(): Kassa {
  try {
    const value = localStorage.getItem(KEY);
    return value === "andijan" ? "andijan" : "moscow";
  } catch {
    return "moscow";
  }
}

/**
 * The cash desk of the signed-in person: their city's, or for a person of everywhere the one they chose last on this
 * device (Moscow at first).
 */
export function KassaProvider({ city, children }: { city: Kassa | null | undefined; children: ReactNode }) {
  const [chosen, setChosen] = useState<Kassa>(kept);
  const setKassa = useCallback((kassa: Kassa) => {
    setChosen(kassa);
    try {
      localStorage.setItem(KEY, kassa);
    } catch {
      // not kept: the next visit starts from Moscow
    }
  }, []);
  const value = useMemo<KassaState>(
    () => (city ? { kassa: city, choosable: false, setKassa: () => {} } : { kassa: chosen, choosable: true, setKassa }),
    [city, chosen, setKassa],
  );
  return <KassaContext.Provider value={value}>{children}</KassaContext.Provider>;
}

export function useKassa(): KassaState {
  return useContext(KassaContext);
}
