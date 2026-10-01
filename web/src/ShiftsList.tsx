import { useCallback, useEffect, useRef, useState } from "react";
import { fetchShifts, SessionExpiredError, type ShiftReport } from "./api";
import { formatMoscowShort } from "./days";
import { CURRENCY_NAME, formatDifference, formatMoney } from "./money";

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
  | { kind: "ready"; shifts: ShiftReport[]; nextBefore: string | null; refreshFailed: boolean; moreFailed: boolean; loadingMore: boolean };

/** The owner's list of shifts: who worked, when, and how the count of the cash came out. Newest first. */
export function ShiftsList({ onSessionExpired, onRefresh, active = true }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  useEffect(() => {
    if (!active) return;
    const mine = ++newest.current;
    fetchShifts().then(
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
  }, [active, reloadCount, onSessionExpired]);

  const refresh = useCallback(() => {
    setReloadCount((count) => count + 1);
    onRefresh?.();
  }, [onRefresh]);

  async function loadMore() {
    if (load.kind !== "ready" || !load.nextBefore || load.loadingMore) return;
    const { nextBefore } = load;
    setLoad({ ...load, loadingMore: true, moreFailed: false });
    try {
      const page = await fetchShifts(nextBefore);
      setLoad((current) =>
        current.kind === "ready" ? { ...current, shifts: [...current.shifts, ...page.shifts], nextBefore: page.nextBefore, loadingMore: false } : current,
      );
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setLoad((current) => (current.kind === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
    }
  }

  return (
    <section className="shifts" aria-label="Смены">
      <div className="journal-head">
        <h2>Смены</h2>
        <button type="button" className="secondary small" onClick={refresh}>
          Обновить
        </button>
      </div>

      {load.kind === "loading" && <p className="hint">Загружаем…</p>}
      {load.kind === "failed" && (
        <>
          <p className="error" role="alert">
            Не удалось загрузить смены. Проверьте связь и попробуйте ещё раз.
          </p>
          <button type="button" className="secondary" onClick={refresh}>
            Повторить
          </button>
        </>
      )}
      {load.kind === "ready" && (
        <>
          {load.refreshFailed && (
            <p className="error" role="alert">
              Не удалось обновить список: показан прежний. Проверьте связь и нажмите «Обновить».
            </p>
          )}
          {load.shifts.length === 0 ? (
            <p className="hint">Смен ещё не было.</p>
          ) : (
            <ul className="shift-list">
              {load.shifts.map((shift) => (
                <ShiftCard key={shift.id} shift={shift} />
              ))}
            </ul>
          )}
          {load.nextBefore && (
            <button type="button" className="secondary" disabled={load.loadingMore} onClick={() => void loadMore()}>
              {load.loadingMore ? "Загружаем…" : "Показать ещё"}
            </button>
          )}
          {load.moreFailed && (
            <p className="error" role="alert">
              Не удалось загрузить следующие смены.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ShiftCard({ shift }: { shift: ShiftReport }) {
  const closed = shift.closedAt !== null;
  return (
    <li className="shift-card" data-shift={shift.id}>
      <p className="shift-card-head">
        <strong>{shift.cashier.displayName}</strong>
        {!closed && <span className="badge open">открыта</span>}
      </p>
      <p className="shift-card-times">
        С {formatMoscowShort(shift.openedAt)}
        {closed ? ` до ${formatMoscowShort(shift.closedAt!)}` : ""} (МСК)
      </p>
      <dl>
        {shift.currencies.map((item) => {
          const difference = item.differenceMinor;
          return (
            <div className="shift-row" key={item.currency} data-currency={item.currency}>
              <dt>{CURRENCY_NAME[item.currency]}</dt>
              <dd>
                {closed ? (
                  <>
                    <span className="shift-counts">
                      по книге {formatMoney(item.calculatedMinor ?? 0, item.currency)}, насчитано {formatMoney(item.actualMinor ?? 0, item.currency)}
                    </span>{" "}
                    <strong data-difference className={difference === 0 || difference === null ? "agrees" : difference < 0 ? "shortage" : "surplus"}>
                      {difference === 0 || difference === null ? "сошлось" : formatDifference(difference, item.currency)}
                    </strong>
                  </>
                ) : (
                  <span className="shift-counts">на начало {formatMoney(item.openingMinor, item.currency)}</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}
