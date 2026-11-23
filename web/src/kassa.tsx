import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Currency } from "./money";

/** The id of a cash desk ("moscow"). Which desks there are is the server's to say: the settings of its installation. */
export type Kassa = string;

/** A cash desk of the business, as the server names it (`GET /api/kassas`). */
export type KassaInfo = {
  id: Kassa;
  /** What the screens call it: «Москва». */
  label: string;
  /** Its mark on an entry when the journal shows several desks: «МСК». */
  short: string;
  /** The money it keeps, rubles first. */
  currencies: readonly Currency[];
  /** The payments of clients of this desk are written to 1C. */
  onec: boolean;
};

/**
 * The desks of a server that does not say which it has (an older version), and of a phone that could never ask:
 * Moscow keeps rubles and dollars, Andijan dollars only.
 */
export const DEFAULT_KASSAS: readonly KassaInfo[] = [
  { id: "moscow", label: "Москва", short: "МСК", currencies: ["RUB", "USD"], onec: true },
  { id: "andijan", label: "Андижан", short: "АНД", currencies: ["USD"], onec: false },
];

/** What the journal, the totals and the counts show: one desk, or all of them («Обе кассы»), for a person of everywhere. */
export type Scope = Kassa | "both";

const KEY = "kassa.kassa";
const SCOPE_KEY = "kassa.scope";
const ALL_CURRENCIES: readonly Currency[] = ["RUB", "USD"];

/** What the person has chosen, or what their city chooses for them. */
type Chosen = {
  /** The cash desk the forms write to, and whose balances they show. */
  kassa: Kassa;
  /** A person of everywhere chooses; a person of a city works in that city's desk only. */
  choosable: boolean;
  setKassa: (kassa: Kassa) => void;
  /** The desk (or all of them) of the journal, the totals and the counts. A person of a city sees their own desk. */
  scope: Scope;
  setScope: (scope: Scope) => void;
};

/** What the desks of the business say about themselves. The same functions for as long as the desks are the same. */
type Desks = {
  /** The cash desks of the business, the main one first. */
  kassas: readonly KassaInfo[];
  /** What a desk is called; an entry that names none (an older server) is of the main desk. */
  labelOf: (kassa: Kassa | null | undefined) => string;
  /** The mark of a desk on an entry. */
  shortOf: (kassa: Kassa | null | undefined) => string;
  /** The money a desk keeps. */
  currenciesOf: (kassa: Kassa | null | undefined) => readonly Currency[];
  /** Whether the payments of clients of a desk go to 1C. */
  writesToOneC: (kassa: Kassa | null | undefined) => boolean;
  /**
   * Whether another desk keeps the same money as this one. Then nothing on a screen but its name tells the two apart
   * (a count of dollars only is Andijan's while Moscow keeps rubles too; among three desks of dollars it is
   * anybody's), and what is said of the desk says its name.
   */
  alike: (kassa: Kassa | null | undefined) => boolean;
  /** The currencies a scope shows: all the desks together keep every currency that one of them keeps. */
  scopeCurrencies: (scope: Scope) => readonly Currency[];
  /** What the choice of every desk is called: «Обе кассы» for two, «Все кассы» for more. */
  allLabel: string;
};

type KassaState = Desks & Chosen;

function desksOf(kassas: readonly KassaInfo[]): Desks {
  const primary = kassas[0]?.id ?? "moscow";
  const find = (kassa: Kassa | null | undefined) => kassas.find((item) => item.id === (kassa ?? primary));
  const everyCurrency = ALL_CURRENCIES.filter((currency) => kassas.some((item) => item.currencies.includes(currency)));
  return {
    kassas,
    // A desk the server does not name (the person's city was taken out of the settings): its id, and every currency.
    labelOf: (kassa) => find(kassa)?.label ?? kassa ?? "",
    shortOf: (kassa) => find(kassa)?.short ?? (kassa ?? "").slice(0, 3).toUpperCase(),
    currenciesOf: (kassa) => find(kassa)?.currencies ?? everyCurrency,
    writesToOneC: (kassa) => find(kassa)?.onec ?? false,
    alike: (kassa) => {
      const own = find(kassa);
      return own !== undefined && kassas.some((item) => item.id !== own.id && item.currencies.join() === own.currencies.join());
    },
    scopeCurrencies: (scope) => (scope === "both" ? everyCurrency : (find(scope)?.currencies ?? everyCurrency)),
    allLabel: kassas.length > 2 ? "Все кассы" : "Обе кассы",
  };
}

const NOTHING_TO_CHOOSE = { choosable: false, setKassa: () => {}, setScope: () => {} } as const;

const KassaContext = createContext<KassaState>({ ...desksOf(DEFAULT_KASSAS), ...NOTHING_TO_CHOOSE, kassa: "moscow", scope: "moscow" });

function kept(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept: the next visit starts from the default
  }
}

/** The kassa an API call asks for: a scope of all asks for none, which the server answers with all of them. */
export const scopeKassa = (scope: Scope): Kassa | undefined => (scope === "both" ? undefined : scope);

/**
 * The cash desk of the signed-in person: their city's, or for a person of everywhere the one they chose last on this
 * device (the main one at first), and what they look at in the journal (all the desks at first). `initial` are the
 * desks as the app knew them when it opened; when they did not come from the server (no connection then), `refresh`
 * asks again once the connection is back.
 */
export function KassaProvider({
  city,
  initial,
  fresh,
  refresh,
  children,
}: {
  city: Kassa | null | undefined;
  initial: readonly KassaInfo[];
  fresh: boolean;
  refresh?: () => Promise<{ kassas: readonly KassaInfo[]; fresh: boolean }>;
  children: ReactNode;
}) {
  const [kassas, setKassas] = useState<readonly KassaInfo[]>(initial.length > 0 ? initial : DEFAULT_KASSAS);
  const [chosen, setChosen] = useState<string | null>(() => kept(KEY));
  const [chosenScope, setChosenScope] = useState<string | null>(() => kept(SCOPE_KEY));
  // The desks are what the phone remembered, not what the server said now: it is asked again until it answers.
  const [remembered, setRemembered] = useState(!fresh);

  useEffect(() => {
    if (!remembered || !refresh) return;
    let current = true;
    const again = () =>
      void refresh().then((answer) => {
        if (!current || !answer.fresh) return;
        if (answer.kassas.length > 0) setKassas(answer.kassas);
        setRemembered(false);
      });
    // The connection is back, or the app is in front again (the server may have been restarting when it opened).
    const cameBack = () => {
      if (document.visibilityState === "visible") again();
    };
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", cameBack);
    return () => {
      current = false;
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", cameBack);
    };
  }, [remembered, refresh]);

  const setKassa = useCallback((kassa: Kassa) => {
    setChosen(kassa);
    keep(KEY, kassa);
  }, []);
  const setScope = useCallback((scope: Scope) => {
    setChosenScope(scope);
    keep(SCOPE_KEY, scope);
  }, []);

  // Made anew only when the desks change: what depends on these functions is not done again for a choice.
  const desks = useMemo(() => desksOf(kassas), [kassas]);
  const value = useMemo<KassaState>(() => {
    const primary = kassas[0]!.id;
    const known = (id: string | null): id is Kassa => id !== null && kassas.some((item) => item.id === id);
    if (city) return { ...desks, ...NOTHING_TO_CHOOSE, kassa: city, scope: city };
    // A business with one desk has nothing to choose.
    if (kassas.length === 1) return { ...desks, ...NOTHING_TO_CHOOSE, kassa: primary, scope: primary };
    return {
      ...desks,
      // What was chosen before may be a desk the business does not have any more.
      kassa: known(chosen) ? chosen : primary,
      choosable: true,
      setKassa,
      scope: chosenScope === "both" || known(chosenScope) ? chosenScope : "both",
      setScope,
    };
  }, [desks, kassas, city, chosen, chosenScope, setKassa, setScope]);
  return <KassaContext.Provider value={value}>{children}</KassaContext.Provider>;
}

export function useKassa(): KassaState {
  return useContext(KassaContext);
}
