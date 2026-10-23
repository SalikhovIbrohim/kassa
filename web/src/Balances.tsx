import { useEffect, useState } from "react";
import { fetchBalances, NetworkError, SessionExpiredError, type Balance } from "./api";
import { KASSA_CURRENCIES, KASSA_LABEL, KASSAS, useKassa, type Kassa, type Scope } from "./kassa";
import { formatMoney, type Currency } from "./money";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
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

/**
 * Above a form: the balance of the desk the form writes to. A person of everywhere chooses the desk here (Москва or
 * Андижан); everybody else sees the name of their own.
 */
export function BalanceStrip({ balances, onRetry }: { balances: BalancesState; onRetry: () => void }) {
  const { kassa, choosable, setKassa } = useKassa();
  return (
    <section aria-label="Остатки" className="glass-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-3">
      {choosable ? (
        <Segmented<Kassa>
          label="Касса"
          size="sm"
          className="w-[190px]"
          value={kassa}
          onChange={setKassa}
          options={KASSAS.map((item) => ({ value: item, label: KASSA_LABEL[item] }))}
        />
      ) : (
        <span className="text-[12.5px] font-semibold text-muted-foreground">Остаток · {KASSA_LABEL[kassa]}</span>
      )}
      <span className="ml-auto flex flex-wrap justify-end gap-x-3.5 text-[15px]">
        {balances === undefined ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 text-destructive" onClick={onRetry}>
            Остатки: повторить
          </Button>
        ) : (
          KASSA_CURRENCIES[kassa].map((currency) => <Amount key={currency} balances={balances} currency={currency} />)
        )}
      </span>
    </section>
  );
}

/** For a person of everywhere: which desk the journal, the totals and the counts show, or both. */
export function ScopeSwitch() {
  const { choosable, scope, setScope } = useKassa();
  if (!choosable) return null;
  return (
    <Segmented<Scope>
      label="Касса"
      className="max-w-[440px]"
      value={scope}
      onChange={setScope}
      options={[
        { value: "both", label: "Обе кассы" },
        { value: "moscow", label: "Москва" },
        { value: "andijan", label: "Андижан" },
      ]}
    />
  );
}

/**
 * Over the journal, the totals and the counts: the balances of the desk shown, or of each desk on a line of its own in
 * «Обе кассы» (the currencies are never added across desks).
 */
export function ScopeBalances({ onSessionExpired, reload = 0 }: { onSessionExpired: () => void; reload?: number }) {
  const { scope } = useKassa();
  const kassas: readonly Kassa[] = scope === "both" ? KASSAS : [scope];
  const [shown, setShown] = useState<Partial<Record<Kassa, BalancesState>>>({});

  useEffect(() => {
    let current = true;
    setShown({});
    for (const kassa of scope === "both" ? KASSAS : [scope]) {
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
  }, [scope, reload, onSessionExpired]);

  return (
    <section aria-label="Остатки" className="glass-card grid rounded-xl px-[18px] py-3">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-[14px] font-semibold text-muted-foreground">{kassas.length > 1 ? "Остатки по кассам" : `Остаток · ${KASSA_LABEL[kassas[0]!]}`}</span>
        {kassas.length > 1 && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">валюты отдельно</span>}
      </div>
      {kassas.map((kassa) => (
        <div key={kassa} data-kassa={kassa} className="flex items-baseline justify-between gap-3 border-t py-2.5 first-of-type:border-t-0">
          {kassas.length > 1 && <span className="text-[14px] font-semibold text-muted-foreground">{KASSA_LABEL[kassa]}</span>}
          <span className={cn("flex flex-wrap gap-x-4 font-bold tracking-tight", kassas.length > 1 ? "justify-end text-[clamp(18px,5.5vw,24px)]" : "text-[clamp(22px,7vw,30px)]")}>
            {KASSA_CURRENCIES[kassa].map((currency) => (
              <Amount key={currency} balances={shown[kassa] ?? null} currency={currency} />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}
