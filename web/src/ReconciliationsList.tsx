import { scopeKassa, useKassa } from "./kassa";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReconciliations, SessionExpiredError, type Reconciliation } from "./api";
import { formatMoscowShort } from "./days";
import { CURRENCY_NAME, formatDifference, formatMoney } from "./money";
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
  const { scope } = useKassa();
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
      <div className="journal-head">
        <h2>Сверки</h2>
        <Button type="button" variant="outline" size="sm" onClick={refresh}>
          Обновить
        </Button>
      </div>

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
            <ul className="reconciliation-list">
              {load.reconciliations.map((item) => (
                <ReconciliationCard key={item.id} reconciliation={item} />
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

function ReconciliationCard({ reconciliation }: { reconciliation: Reconciliation }) {
  return (
    <li className="reconciliation-card glass-card rounded-xl" data-reconciliation={reconciliation.id}>
      <p className="reconciliation-card-head">
        <strong>{reconciliation.madeBy.displayName}</strong>
      </p>
      <p className="reconciliation-card-time">{formatMoscowShort(reconciliation.madeAt)} (МСК)</p>
      <dl>
        {reconciliation.currencies.map((item) => (
          <div className="reconciliation-row" key={item.currency} data-currency={item.currency}>
            <dt>{CURRENCY_NAME[item.currency]}</dt>
            <dd>
              <span className="reconciliation-counts">
                по книге {formatMoney(item.calculatedMinor, item.currency)}, насчитано {formatMoney(item.actualMinor, item.currency)}
              </span>{" "}
              <strong data-difference className={item.differenceMinor === 0 ? "agrees" : item.differenceMinor < 0 ? "shortage" : "surplus"}>
                {item.differenceMinor === 0 ? "сошлось" : formatDifference(item.differenceMinor, item.currency)}
              </strong>
            </dd>
          </div>
        ))}
        {reconciliation.cardMinor != null && (
          <div className="reconciliation-row" data-currency="card">
            <dt>Из рублей</dt>
            <dd>
              наличными {formatMoney(Math.max(0, (reconciliation.currencies.find((item) => item.currency === "RUB")?.actualMinor ?? 0) - reconciliation.cardMinor), "RUB")}, на карте{" "}
              {formatMoney(reconciliation.cardMinor, "RUB")}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}
