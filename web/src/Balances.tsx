import { useEffect, useState } from "react";
import { fetchBalances, NetworkError, SessionExpiredError, type Balance } from "./api";
import { useKassa, type Kassa, type Scope } from "./kassa";
import { formatMoney, type Currency } from "./money";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Null while loading, undefined when loading failed, "offline" when the server could not be reached. */
export type BalancesState = Balance[] | null | undefined | "offline";

type Props = {
  balances: BalancesState;
  onRetry: () => void;
  /** Entries of this cashier that are on the phone and not on the server: the balances do not count them. */
  unsent?: number;
};

/**
 * What the balances do not say by themselves: that entries on the phone are not counted yet, or that there is no
 * connection. Nothing when all is well.
 */
export function BalanceNotes({ balances, onRetry, unsent = 0 }: Props) {
  if (unsent === 0 && balances !== "offline") return null;
  return (
    <div className="grid gap-1 px-2">
      {unsent > 0 && (
        <p className="hint balances-unsent m-0">
          Остатки без учёта неотправленных записей: {unsent}. <a href="#queue">Показать</a>
        </p>
      )}
      {balances === "offline" && (
        <p className="hint balances-offline m-0">
          Нет связи: остатков не видно. Они появятся, когда связь вернётся.{" "}
          <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={onRetry}>
            Проверить
          </Button>
        </p>
      )}
    </div>
  );
}

/** One balance: the amount, "…" while it loads, "—" without a connection; red below zero. */
function Amount({ balances, currency }: { balances: BalancesState; currency: Currency }) {
  const balance = Array.isArray(balances) ? balances.find((item) => item.currency === currency) : undefined;
  const text = balance ? formatMoney(balance.amountMinor, currency) : balances === "offline" ? "—" : "…";
  return (
    <strong data-currency={currency} className={cn("font-semibold whitespace-nowrap tabular-nums", balance && balance.amountMinor < 0 && "text-destructive")}>
      {text}
    </strong>
  );
}

/** More cash desks than this do not fit a row of buttons on a phone: they are chosen from a list instead. */
const MOST_SEGMENTS = 3;

/**
 * Above a form: the balance of the desk the form writes to. A person of everywhere chooses the desk here (Москва or
 * Андижан); everybody else sees the name of their own.
 */
export function BalanceStrip({ balances, onRetry }: { balances: BalancesState; onRetry: () => void }) {
  const { kassas, kassa, choosable, setKassa, labelOf, currenciesOf } = useKassa();
  const options = kassas.map((item) => ({ value: item.id, label: item.label }));
  return (
    <section aria-label="Остатки" className="glass-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-3">
      {!choosable ? (
        <span className="text-[12.5px] font-semibold text-muted-foreground">Остаток · {labelOf(kassa)}</span>
      ) : kassas.length > MOST_SEGMENTS ? (
        <Select aria-label="Касса" className="w-[190px]" value={kassa} onChange={setKassa} options={options} />
      ) : (
        <Segmented<Kassa>
          label="Касса"
          size="sm"
          // Two desks fit beside the balance; three take the row, and the balance goes under them.
          className={kassas.length > 2 ? "w-full" : "w-[190px]"}
          value={kassa}
          onChange={setKassa}
          options={options}
        />
      )}
      <span className="ml-auto flex flex-wrap justify-end gap-x-3.5 text-[15px]">
        {balances === undefined ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 text-destructive" onClick={onRetry}>
            Остатки: повторить
          </Button>
        ) : (
          currenciesOf(kassa).map((currency) => <Amount key={currency} balances={balances} currency={currency} />)
        )}
      </span>
    </section>
  );
}

/** For a person of everywhere: which desk the journal, the totals and the counts show, or all of them. */
export function ScopeSwitch() {
  const { kassas, choosable, scope, setScope, allLabel } = useKassa();
  if (!choosable) return null;
  const desks = kassas.map((item) => ({ value: item.id, label: item.label }));
  if (kassas.length > MOST_SEGMENTS) {
    return <Select aria-label="Касса" className="max-w-[440px]" value={scope} onChange={setScope} options={[{ value: "both", label: allLabel }, ...desks]} />;
  }
  return (
    <Segmented<Scope>
      label="Касса"
      className={kassas.length > 2 ? "max-w-[560px]" : "max-w-[440px]"}
      fit={kassas.length > 2 ? "content" : "equal"}
      value={scope}
      onChange={setScope}
      // With three desks the row is full: the choice of all of them is said shorter.
      options={[{ value: "both", label: kassas.length > 2 ? "Все" : allLabel }, ...desks]}
    />
  );
}

/**
 * Over the journal, the totals and the counts: the balances of the desk shown, or of each desk on a line of its own in
 * «Обе кассы» (the currencies are never added across desks).
 */
export function ScopeBalances({ onSessionExpired, reload = 0 }: { onSessionExpired: () => void; reload?: number }) {
  const { kassas: every, scope, labelOf, currenciesOf } = useKassa();
  // The ids as one text: the list is made anew on every render, and the balances are read again only when it changes.
  const shownIds = (scope === "both" ? every.map((item) => item.id) : [scope]).join(",");
  const kassas: readonly Kassa[] = shownIds.split(",");
  const [shown, setShown] = useState<Partial<Record<Kassa, BalancesState>>>({});

  useEffect(() => {
    let current = true;
    setShown({});
    for (const kassa of shownIds.split(",")) {
      fetchBalances(kassa).then(
        (loaded) => {
          if (current) setShown((previous) => ({ ...previous, [kassa]: loaded }));
        },
        (caught: unknown) => {
          if (!current) return;
          if (caught instanceof SessionExpiredError) onSessionExpired();
          else setShown((previous) => ({ ...previous, [kassa]: caught instanceof NetworkError ? "offline" : undefined }));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [shownIds, reload, onSessionExpired]);

  return (
    <section aria-label="Остатки" className="glass-card grid rounded-xl px-[18px] py-3">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-[14px] font-semibold text-muted-foreground">{kassas.length > 1 ? "Остатки по кассам" : `Остаток · ${labelOf(kassas[0]!)}`}</span>
        {kassas.length > 1 && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">валюты отдельно</span>}
      </div>
      {kassas.map((kassa) => (
        <div key={kassa} data-kassa={kassa} className="flex items-baseline justify-between gap-3 border-t py-2.5 first-of-type:border-t-0">
          {kassas.length > 1 && <span className="text-[14px] font-semibold text-muted-foreground">{labelOf(kassa)}</span>}
          <span className={cn("flex flex-wrap gap-x-4 font-bold tracking-tight", kassas.length > 1 ? "justify-end text-[clamp(18px,5.5vw,24px)]" : "text-[clamp(22px,7vw,30px)]")}>
            {currenciesOf(kassa).map((currency) => (
              <Amount key={currency} balances={shown[kassa] ?? null} currency={currency} />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}
