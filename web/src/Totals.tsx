import { scopeKassa, useKassa } from "./kassa";
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
import { formatDay, cashDayToday, presetPeriod, type PeriodPreset } from "./days";
import { CURRENCY_NAME, formatDifference, formatMoney } from "./money";
import { IconButton, PageActions } from "./page-actions";
import { Icon } from "./sections";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  { preset: "month", label: "Месяц" },
];

/** The only category that is shown even when nothing was returned to clients in the period. */

/** "+1 500,00 ₽" or "−1 500,00 ₽"; a zero has no sign. */
function signed(minor: number, sign: "+" | "−", currency: CurrencyTotals["currency"]): string {
  return minor === 0 ? formatMoney(0, currency) : `${sign}${formatMoney(minor, currency)}`;
}

/** The viewer's totals of a period: for each currency what was there at the start, what came in and went out, what is left. */
export function Totals({ onSessionExpired, onRefresh, active = true }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = cashDayToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reloadCount, setReloadCount] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [categories, setCategories] = useState<Category[]>([]);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  // What is asked for: both days chosen and in order. Anything else is said, not sent.
  const problem = from === "" || to === "" ? "Выберите обе даты." : from > to ? "Начало периода позже конца." : null;

  // The totals of the cash desk chosen.
  const { scope } = useKassa();
  const kassa = scopeKassa(scope);
  useEffect(() => {
    fetchCategories().then(setCategories, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
    });
  }, [onSessionExpired]);

  useEffect(() => {
    if (!active || problem) return;
    const request = ++newest.current;
    setLoad((current) => (current.kind === "ready" ? { ...current, stale: true, refreshFailed: false } : { kind: "loading" }));
    fetchTotals(from, to, kassa).then(
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
  }, [active, from, to, problem, reloadCount, onSessionExpired, kassa]);

  const refresh = useCallback(() => {
    setReloadCount((count) => count + 1);
    onRefresh?.();
  }, [onRefresh]);

  const choose = (preset: PeriodPreset) => {
    const period = presetPeriod(preset, today);
    setFrom(period.from);
    setTo(period.to);
  };

  // The period is one of the person's own when no quick choice is it.
  const own = !PRESETS.some(({ preset }) => {
    const wanted = presetPeriod(preset, today);
    return wanted.from === from && wanted.to === to;
  });
  // The two days as they are being chosen in the sheet; asked for on «Показать». What is wrong with them is said there.
  const [sheet, setSheet] = useState<{ from: string; to: string } | null>(null);
  const sheetProblem = sheet === null ? null : sheet.from === "" || sheet.to === "" ? "Выберите обе даты." : sheet.from > sheet.to ? "Начало периода позже конца." : null;

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
      <h2 className="sr-only">Итоги</h2>
      <PageActions active={active}>
        <IconButton icon="calendar" label="Период" pressed={own} onClick={() => setSheet({ from, to })} />
        <IconButton icon="refresh" label="Обновить" onClick={refresh} />
      </PageActions>

      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Быстрый выбор периода" data-presets>
        {PRESETS.map(({ preset, label: text }) => {
          const wanted = presetPeriod(preset, today);
          const chosen = wanted.from === from && wanted.to === to;
          return (
            <Button
              key={preset}
              type="button"
              variant={chosen ? "default" : "outline"}
              size="sm"
              className="min-w-0 px-1"
              aria-pressed={chosen}
              onClick={() => choose(preset)}
            >
              {text}
            </Button>
          );
        })}
      </div>

      {/* A period of the person's own, chosen in the sheet: said as a mark that takes it off (back to today). */}
      {own && (
        <div className="flex flex-wrap items-center gap-1.5" data-chips>
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent pr-1 pl-3 text-[13px] font-semibold" data-chip="period">
            {from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`}
            <button type="button" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Убрать свой период" onClick={() => choose("today")}>
              <Icon name="close" size={13} stroke={2.4} />
            </button>
          </span>
        </div>
      )}
      <Dialog open={sheet !== null} onOpenChange={(next) => !next && setSheet(null)}>
        <DialogContent>
          <DialogTitle>Период</DialogTitle>
          <DialogDescription className="sr-only">Первый и последний день периода, за который считать итоги.</DialogDescription>
          {sheet && (
            <form
              className="grid gap-3"
              aria-label="Период"
              onSubmit={(event) => {
                event.preventDefault();
                if (sheetProblem) return;
                setFrom(sheet.from);
                setTo(sheet.to);
                setSheet(null);
              }}
            >
              <div className="grid grid-cols-2 gap-2.5 [&_input]:min-w-0">
                <Label>
                  С
                  <Input type="date" name="from" aria-label="Период: с" value={sheet.from} max={today} onChange={(event) => setSheet({ ...sheet, from: event.target.value })} />
                </Label>
                <Label>
                  По
                  <Input type="date" name="to" aria-label="Период: по" value={sheet.to} max={today} onChange={(event) => setSheet({ ...sheet, to: event.target.value })} />
                </Label>
              </div>
              {sheetProblem && (
                <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
                  {sheetProblem}
                </p>
              )}
              <Button type="submit" className="h-12" disabled={sheetProblem !== null}>
                Показать
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {problem && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {problem}
        </p>
      )}

      {!problem && load.kind === "loading" && <p className="hint">Загружаем…</p>}

      {!problem && load.kind === "failed" && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить итоги. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={refresh}>
            Повторить
          </Button>
        </>
      )}

      {shown && (
        <>
          {shown.refreshFailed && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
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
  const rows = totals.expenseByCategory.filter((row) => row.amountMinor > 0);
  return (
    <section className="total-card glass-card rounded-xl" aria-label={CURRENCY_NAME[currency]}>
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
            <dt>Разница при сверке кассы</dt>
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
        {formatMoney(side.rubMinor, "RUB")}. Расход без курса считается по среднему курсу рублёвых приходов его дня, а приходов с курсом пока не было вовсе.
      </p>
    );
  return (
    <section className="total-card dollars glass-card rounded-xl" aria-label="В долларах">
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
