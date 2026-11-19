import { scopeKassa, useKassa } from "./kassa";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReconciliations, SessionExpiredError, type Reconciliation } from "./api";
import { formatMoscowShort } from "./days";
import { CURRENCY_NAME, formatDifference, formatMoney } from "./money";
import { IconButton, PageActions } from "./page-actions";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type Props = {
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh?: () => void;
  /** The screen is on show: a hidden one asks for nothing, and asks again when it comes back. */
  active?: boolean;
};

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; reconciliations: Reconciliation[]; nextBefore: string | null; refreshFailed: boolean; moreFailed: boolean; loadingMore: boolean };

/** The owner's list of the counts of the cash: who counted, when, and how the count came out. Newest first. */
export function ReconciliationsList({ onSessionExpired, onRefresh, active = true }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  // The counts of the cash desk chosen.
  const { scope, alike } = useKassa();
  const kassa = scopeKassa(scope);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  useEffect(() => {
    if (!active) return;
    const mine = ++newest.current;
    fetchReconciliations(undefined, kassa).then(
      (page) => {
        if (mine === newest.current) setLoad({ kind: "ready", ...page, refreshFailed: false, moreFailed: false, loadingMore: false });
      },
      (caught: unknown) => {
        if (mine !== newest.current) return;
        if (caught instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }
        setLoad((current) => (current.kind === "ready" ? { ...current, refreshFailed: true } : { kind: "failed" }));
      },
    );
  }, [active, reloadCount, onSessionExpired, kassa]);

  const refresh = useCallback(() => {
    setReloadCount((count) => count + 1);
    onRefresh?.();
  }, [onRefresh]);

  async function loadMore() {
    if (load.kind !== "ready" || !load.nextBefore || load.loadingMore) return;
    const { nextBefore } = load;
    setLoad({ ...load, loadingMore: true, moreFailed: false });
    try {
      const page = await fetchReconciliations(nextBefore, kassa);
      setLoad((current) =>
        current.kind === "ready"
          ? { ...current, reconciliations: [...current.reconciliations, ...page.reconciliations], nextBefore: page.nextBefore, loadingMore: false }
          : current,
      );
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setLoad((current) => (current.kind === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
    }
  }

  return (
    <section className="reconciliations" aria-label="Сверки">
      <h2 className="sr-only">Сверки</h2>
      <PageActions active={active}>
        <IconButton icon="refresh" label="Обновить" onClick={refresh} />
      </PageActions>

      {load.kind === "loading" && <p className="hint">Загружаем…</p>}
      {load.kind === "failed" && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить сверки. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={refresh}>
            Повторить
          </Button>
        </>
      )}
      {load.kind === "ready" && (
        <>
          {load.refreshFailed && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              Не удалось обновить список: показан прежний. Проверьте связь и нажмите «Обновить».
            </p>
          )}
          {load.reconciliations.length === 0 ? (
            <p className="hint">Сверок ещё не было.</p>
          ) : (
            <ul className="grid gap-3">
              {load.reconciliations.map((item) => (
                // Several desks are shown: a count of a desk that its money does not tell from another says its name.
                <ReconciliationCard key={item.id} reconciliation={item} named={scope === "both" && alike(item.kassa)} />
              ))}
            </ul>
          )}
          {load.nextBefore && (
            <Button type="button" variant="outline" disabled={load.loadingMore} onClick={() => void loadMore()}>
              {load.loadingMore ? "Загружаем…" : "Показать ещё"}
            </Button>
          )}
          {load.moreFailed && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              Не удалось загрузить следующие сверки.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One count of the cash, after the prototype: who counted, under the name the cash desk and the time, and at the right
 * how it came out; then for each currency what the book said, what was counted and the difference (nothing in grey, a
 * shortage in red).
 */
function ReconciliationCard({ reconciliation }: { reconciliation: Reconciliation; named: boolean }) {
  const { labelOf } = useKassa();
  const short = reconciliation.currencies.some((item) => item.differenceMinor < 0);
  const over = reconciliation.currencies.some((item) => item.differenceMinor > 0);
  const verdict = short ? "Недостача" : over ? "Излишек" : "Сошлось";
  const cash = reconciliation.cardMinor == null ? null : Math.max(0, (reconciliation.currencies.find((item) => item.currency === "RUB")?.actualMinor ?? 0) - reconciliation.cardMinor);
  return (
    <li className="reconciliation-card glass-card grid gap-3 rounded-[26px] px-4 py-3.5" data-reconciliation={reconciliation.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate text-[15px]">{reconciliation.madeBy.displayName}</strong>
          <span className="truncate text-[12.5px] text-muted-foreground">
            {labelOf(reconciliation.kassa)} · {formatMoscowShort(reconciliation.madeAt)} (МСК)
          </span>
        </div>
        <span
          className={cn(
            "inline-flex h-6 flex-none items-center rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap",
            short ? "bg-destructive/12 text-destructive" : over ? "bg-warning-bg text-warning" : "bg-success/12 text-success",
          )}
          data-verdict
        >
          {verdict}
        </span>
      </div>
      {reconciliation.currencies.map((item) => (
        <div key={item.currency} className="grid gap-1.5 border-t pt-2.5" data-currency={item.currency}>
          {reconciliation.currencies.length > 1 && <div className="text-[12px] font-semibold tracking-[.05em] text-muted-foreground uppercase">{CURRENCY_NAME[item.currency]}</div>}
          <dl className="grid grid-cols-3 gap-2 tabular-nums">
            {(
              [
                ["По книге", formatMoney(item.calculatedMinor, item.currency), ""],
                ["Насчитано", formatMoney(item.actualMinor, item.currency), ""],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="grid min-w-0 gap-0.5">
                <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
                <dd className="text-[14px] font-semibold whitespace-nowrap">{value}</dd>
              </div>
            ))}
            <div className="grid min-w-0 justify-items-end gap-0.5 text-right">
              <dt className="text-[11.5px] text-muted-foreground">Разница</dt>
              <dd
                data-difference
                className={cn(
                  "text-[14px] font-bold whitespace-nowrap",
                  item.differenceMinor === 0 ? "agrees text-muted-foreground" : item.differenceMinor < 0 ? "shortage text-destructive" : "surplus text-success",
                )}
              >
                {formatDifference(item.differenceMinor, item.currency)}
              </dd>
            </div>
          </dl>
        </div>
      ))}
      {cash !== null && (
        <p className="border-t pt-2.5 text-[13px] text-muted-foreground" data-currency="card">
          Из рублей: наличными {formatMoney(cash, "RUB")}, на карте {formatMoney(reconciliation.cardMinor!, "RUB")}
        </p>
      )}
    </li>
  );
}
