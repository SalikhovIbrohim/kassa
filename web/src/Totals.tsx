import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCategories,
  fetchTotals,
  SessionExpiredError,
  type Category,
  type CurrencyTotals,
  type DollarTotals,
  type Totals as TotalsData,
} from "./api";
import { formatDay, moscowToday, presetPeriod, type PeriodPreset } from "./days";
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
  | {
      kind: "ready";
      /** The period these totals are for. */
      from: string;
      to: string;
      data: TotalsData;
      /** A newer answer is on its way: what is shown is for the period before. */
      stale: boolean;
      /** The last refresh failed; what is shown is from before. */
      refreshFailed: boolean;
    };

const PRESETS: Array<{ preset: PeriodPreset; label: string }> = [
  { preset: "today", label: "Сегодня" },
  { preset: "yesterday", label: "Вчера" },
  { preset: "week", label: "7 дней" },
  { preset: "month", label: "Этот месяц" },
];

/** The only category that is shown even when nothing was returned to clients in the period. */
const REFUND_CATEGORY = "client_refund";

/** "+1 500,00 ₽" or "−1 500,00 ₽"; a zero has no sign. */
function signed(minor: number, sign: "+" | "−", currency: CurrencyTotals["currency"]): string {
  return minor === 0 ? formatMoney(0, currency) : `${sign}${formatMoney(minor, currency)}`;
}

/** The viewer's totals of a period: for each currency what was there at the start, what came in and went out, what is left. */
export function Totals({ onSessionExpired, onRefresh, active = true }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = moscowToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reloadCount, setReloadCount] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [categories, setCategories] = useState<Category[]>([]);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  // What is asked for: both days chosen and in order. Anything else is said, not sent.
  const problem = from === "" || to === "" ? "Выберите обе даты." : from > to ? "Начало периода позже конца." : null;

  useEffect(() => {
    fetchCategories().then(setCategories, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
    });
  }, [onSessionExpired]);

  useEffect(() => {
    if (!active || problem) return;
    const request = ++newest.current;
    setLoad((current) => (current.kind === "ready" ? { ...current, stale: true, refreshFailed: false } : { kind: "loading" }));
    fetchTotals(from, to).then(
      (data) => {
        if (request === newest.current) setLoad({ kind: "ready", from, to, data, stale: false, refreshFailed: false });
      },
      (caught: unknown) => {
        if (request !== newest.current) return;
        if (caught instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }
        setLoad((current) => (current.kind === "ready" ? { ...current, stale: false, refreshFailed: true } : { kind: "failed" }));
      },
    );
  }, [active, from, to, problem, reloadCount, onSessionExpired]);

  const refresh = useCallback(() => {
    setReloadCount((count) => count + 1);
    onRefresh?.();
  }, [onRefresh]);

  const choose = (preset: PeriodPreset) => {
    const period = presetPeriod(preset, today);
    setFrom(period.from);
    setTo(period.to);
  };

  const label = (code: string) => categories.find((item) => item.code === code)?.label ?? code;

  const shown = load.kind === "ready" ? load : null;
  const period =
    shown === null
      ? ""
      : shown.from === shown.to
        ? `За ${formatDay(shown.from)}`
        : `С ${formatDay(shown.from)} по ${formatDay(shown.to)}`;

  return (
    <section className="totals" aria-label="Итоги" aria-busy={shown?.stale === true || load.kind === "loading"}>
      <div className="journal-head">
        <h2>Итоги</h2>
        <button type="button" className="secondary small" onClick={refresh}>
          Обновить
        </button>
      </div>

      <div className="presets" role="group" aria-label="Быстрый выбор периода">
        {PRESETS.map(({ preset, label: text }) => {
          const wanted = presetPeriod(preset, today);
          const chosen = wanted.from === from && wanted.to === to;
          return (
            <button
              key={preset}
              type="button"
              className={chosen ? "secondary small chosen" : "secondary small"}
              aria-pressed={chosen}
              onClick={() => choose(preset)}
            >
              {text}
            </button>
          );
        })}
      </div>

      <div className="filter-grid">
        <label>
          С
          <input type="date" name="from" aria-label="Период: с" value={from} max={today} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          По
          <input type="date" name="to" aria-label="Период: по" value={to} max={today} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}

      {!problem && load.kind === "loading" && <p className="hint">Загружаем…</p>}

      {!problem && load.kind === "failed" && (
        <>
          <p className="error" role="alert">
            Не удалось загрузить итоги. Проверьте связь и попробуйте ещё раз.
          </p>
          <button type="button" className="secondary" onClick={refresh}>
            Повторить
          </button>
        </>
      )}

      {shown && (
        <>
          {shown.refreshFailed && (
            <p className="error" role="alert">
              Не удалось обновить итоги: показаны прежние. Проверьте связь и нажмите «Обновить».
            </p>
          )}
          <p className="period" role="status">
            {period}
            {shown.stale ? ". Обновляем…" : ""}
          </p>
          <div className="totals-cards">
            <DollarCard usd={shown.data.usd} />
            {shown.data.currencies.map((item) => (
              <CurrencyCard key={item.currency} totals={item} label={label} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CurrencyCard({ totals, label }: { totals: CurrencyTotals; label: (code: string) => string }) {
  const { currency } = totals;
  const rows = totals.expenseByCategory.filter((row) => row.amountMinor > 0 || row.category === REFUND_CATEGORY);
  return (
    <section className="total-card" aria-label={CURRENCY_NAME[currency]}>
      <h3>{CURRENCY_NAME[currency]}</h3>
      <dl>
        <div className="total-row">
          <dt>Остаток на начало</dt>
          <dd data-total="opening">{formatMoney(totals.openingMinor, currency)}</dd>
        </div>
        <div className={totals.incomeMinor === 0 ? "total-row income zero" : "total-row income"}>
          <dt>Приход</dt>
          <dd data-total="income">{signed(totals.incomeMinor, "+", currency)}</dd>
        </div>
        <div className={totals.expenseMinor === 0 ? "total-row expense zero" : "total-row expense"}>
          <dt>Расход</dt>
          <dd data-total="expense">{signed(totals.expenseMinor, "−", currency)}</dd>
        </div>
        {rows.map((row) => (
          <div className={row.amountMinor === 0 ? "total-row sub zero" : "total-row sub"} key={row.category}>
            <dt>{label(row.category)}</dt>
            <dd data-category={row.category}>{signed(row.amountMinor, "−", currency)}</dd>
          </div>
        ))}
        <div className={totals.handoverMinor === 0 ? "total-row expense zero" : "total-row expense"}>
          <dt>Передано владельцу</dt>
          <dd data-total="handover">{signed(totals.handoverMinor, "−", currency)}</dd>
        </div>
        {totals.differenceMinor !== 0 && (
          <div className={totals.differenceMinor < 0 ? "total-row expense" : "total-row income"}>
            <dt>Разница при сверке (смены закрыты)</dt>
            <dd data-total="difference">{formatDifference(totals.differenceMinor, currency)}</dd>
          </div>
        )}
        <div className="total-row closing">
          <dt>Остаток на конец</dt>
          <dd data-total="closing">{formatMoney(totals.closingMinor, currency)}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The period counted in dollars, which is what the owner reckons in: dollars as they are, rubles at the rate of their
 * entry. The cards of the currencies below say how much money is in the cash desk; this one says what the business made.
 */
function DollarCard({ usd }: { usd: DollarTotals }) {
  const { income, expense } = usd.withoutRate;
  const missing = (side: { rubMinor: number; count: number }, what: "income" | "expense") =>
    side.count === 0 ? null : (
      <p className="hint" data-without-rate={what}>
        Не в расчёте: {what === "income" ? "приходов" : "расходов"} в рублях без курса: {side.count}, на{" "}
        {formatMoney(side.rubMinor, "RUB")}. Курс такой записи берётся из среднего по смене, когда смена закрыта.
      </p>
    );
  return (
    <section className="total-card dollars" aria-label="В долларах">
      <h3>В долларах</h3>
      <dl>
        <div className={usd.incomeMinor === 0 ? "total-row income zero" : "total-row income"}>
          <dt>Приход</dt>
          <dd data-usd="income">{signed(usd.incomeMinor, "+", "USD")}</dd>
        </div>
        <div className={usd.expenseMinor === 0 ? "total-row expense zero" : "total-row expense"}>
          <dt>Расход</dt>
          <dd data-usd="expense">{signed(usd.expenseMinor, "−", "USD")}</dd>
        </div>
        <div className={usd.handoverMinor === 0 ? "total-row expense zero" : "total-row expense"}>
          <dt>Передано владельцу</dt>
          <dd data-usd="handover">{signed(usd.handoverMinor, "−", "USD")}</dd>
        </div>
        <div className="total-row closing">
          <dt>Результат (приход минус расход)</dt>
          <dd data-usd="result">{formatDifference(usd.resultMinor, "USD")}</dd>
        </div>
      </dl>
      {missing(income, "income")}
      {missing(expense, "expense")}
    </section>
  );
}
