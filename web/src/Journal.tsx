import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCashiers,
  fetchCategories,
  fetchJournal,
  SessionExpiredError,
  type Cashier,
  type Category,
  type JournalFilters,
  type Operation,
} from "./api";
import { ClientCodeField } from "./ClientCodeField";
import { formatDay, formatMoscowClock, formatMoscowShort, moscowToday, shiftDay } from "./days";
import { CURRENCIES, CURRENCY_NAME, formatMoney, type Currency } from "./money";

type Props = {
  /** A cashier looks at one day of their own operations; the viewer filters everyone's. */
  mode: "cashier" | "viewer";
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh?: () => void;
};

/** What the filter controls hold. Empty text means "any". */
type Draft = {
  from: string;
  to: string;
  currency: "" | Currency;
  type: "" | "income" | "expense";
  category: string;
  clientCode: string;
  author: string;
};

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      /** Which request produced this list; "show more" only ever extends its own list. */
      requestId: number;
      /** The filters this list was asked for, which the next page must use as well. */
      filters: JournalFilters;
      operations: Operation[];
      nextCursor: string | null;
      /** A newer answer is on its way: what is shown is from the filters before. */
      stale: boolean;
      /** The last refresh failed; the list shown is the one from before. */
      refreshFailed: boolean;
      loadingMore: boolean;
      moreFailed: boolean;
    };

const TYPING_PAUSE_MS = 300;

function startingDraft(today: string): Draft {
  return { from: today, to: today, currency: "", type: "", category: "", clientCode: "", author: "" };
}

function toFilters(draft: Draft): JournalFilters {
  return {
    from: draft.from,
    to: draft.to,
    currency: draft.currency || undefined,
    type: draft.type || undefined,
    category: draft.category || undefined,
    clientCode: draft.clientCode.trim() || undefined,
    author: draft.author || undefined,
  };
}

export function Journal({ mode, onSessionExpired, onRefresh }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = moscowToday();
  const [draft, setDraft] = useState<Draft>(() => startingDraft(today));
  // Laptops start with the filters open, phones with them folded; the person's choice sticks.
  const [filtersOpen] = useState(() => window.matchMedia("(min-width: 720px)").matches);
  const [focusId, setFocusId] = useState<string | null>(null);
  // What the list was asked for. It follows the draft at once, except while text is typed.
  const [applied, setApplied] = useState<Draft>(draft);
  const [reloadCount, setReloadCount] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [categories, setCategories] = useState<Category[]>([]);
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  const loadCategories = useCallback(() => {
    fetchCategories().then(setCategories, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
    });
  }, [onSessionExpired]);

  useEffect(() => {
    loadCategories();
    if (mode === "viewer") fetchCashiers().then(setCashiers);
  }, [mode, loadCategories]);

  useEffect(() => {
    const complete = draft.from !== "" && draft.to !== "" && draft.from <= draft.to;
    if (!complete) return;
    const pause = draft.clientCode === applied.clientCode ? 0 : TYPING_PAUSE_MS;
    const timer = setTimeout(() => setApplied(draft), pause);
    return () => clearTimeout(timer);
  }, [draft, applied.clientCode]);

  useEffect(() => {
    const mine = ++newest.current;
    const filters = toFilters(applied);
    setLoad((previous) =>
      previous.kind === "ready" ? { ...previous, stale: true, refreshFailed: false } : { kind: "loading" },
    );
    fetchJournal(filters).then(
      (page) => {
        if (mine !== newest.current) return;
        setLoad({
          kind: "ready",
          requestId: mine,
          filters,
          ...page,
          stale: false,
          refreshFailed: false,
          loadingMore: false,
          moreFailed: false,
        });
      },
      (caught: unknown) => {
        if (mine !== newest.current) return;
        if (caught instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }
        // Keep what was on screen: an old list is more use than an empty one.
        setLoad((previous) =>
          previous.kind === "ready" ? { ...previous, stale: false, refreshFailed: true } : { kind: "failed" },
        );
      },
    );
  }, [applied, reloadCount, onSessionExpired]);

  async function loadMore() {
    if (load.kind !== "ready" || !load.nextCursor || load.loadingMore || load.stale) return;
    const { requestId, filters, nextCursor } = load;
    setLoad({ ...load, loadingMore: true, moreFailed: false });
    try {
      const page = await fetchJournal(filters, nextCursor);
      // Only extend the list this page belongs to: a newer list may have replaced it meanwhile.
      setLoad((previous) =>
        previous.kind === "ready" && previous.requestId === requestId
          ? {
              ...previous,
              operations: [...previous.operations, ...page.operations],
              nextCursor: page.nextCursor,
              loadingMore: false,
            }
          : previous,
      );
      setFocusId(page.operations[0]?.id ?? null);
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else
        setLoad((previous) =>
          previous.kind === "ready" && previous.requestId === requestId
            ? { ...previous, loadingMore: false, moreFailed: true }
            : previous,
        );
    }
  }

  function refresh() {
    setReloadCount((count) => count + 1);
    loadCategories();
    onRefresh?.();
  }

  const labels = useMemo(() => new Map(categories.map((item) => [item.code, item.label])), [categories]);
  const change = (changes: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...changes }));
  const periodIsBackwards = draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  const periodIsIncomplete = draft.from === "" || draft.to === "";
  const shownPeriod =
    applied.from === applied.to
      ? `За ${formatDay(applied.from)}`
      : `С ${formatDay(applied.from)} по ${formatDay(applied.to)}`;

  return (
    <section className="journal" aria-label="Журнал">
      <div className="journal-head">
        <h2>Журнал</h2>
        <button type="button" className="secondary small" onClick={refresh}>
          Обновить
        </button>
      </div>

      {mode === "cashier" ? (
        <div className="day-picker">
          <button
            type="button"
            className="secondary small"
            aria-label="Предыдущий день"
            disabled={draft.from === ""}
            onClick={() => change({ from: shiftDay(draft.from, -1), to: shiftDay(draft.from, -1) })}
          >
            ←
          </button>
          <input
            type="date"
            aria-label="День"
            name="day"
            value={draft.from}
            max={today}
            onChange={(event) => change({ from: event.target.value, to: event.target.value })}
          />
          <button
            type="button"
            className="secondary small"
            aria-label="Следующий день"
            disabled={draft.from === "" || draft.from >= today}
            onClick={() => change({ from: shiftDay(draft.from, 1), to: shiftDay(draft.from, 1) })}
          >
            →
          </button>
        </div>
      ) : (
        <details className="filters" open={filtersOpen}>
          <summary>Фильтры</summary>
          <div className="filter-grid">
            <label>
              С
              <input type="date" name="from" aria-label="Период: с" value={draft.from} max={today} onChange={(e) => change({ from: e.target.value })} />
            </label>
            <label>
              По
              <input type="date" name="to" aria-label="Период: по" value={draft.to} max={today} onChange={(e) => change({ to: e.target.value })} />
            </label>
            <label>
              Валюта
              <select name="currency" value={draft.currency} onChange={(e) => change({ currency: e.target.value as Draft["currency"] })}>
                <option value="">Все</option>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {CURRENCY_NAME[code]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Тип
              <select name="type" value={draft.type} onChange={(e) => change({ type: e.target.value as Draft["type"] })}>
                <option value="">Все</option>
                <option value="income">Приход</option>
                <option value="expense">Расход</option>
              </select>
            </label>
            <label>
              Категория
              <select name="category" value={draft.category} onChange={(e) => change({ category: e.target.value })}>
                <option value="">Все</option>
                {categories.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Кассир
              <select name="author" value={draft.author} onChange={(e) => change({ author: e.target.value })}>
                <option value="">Все</option>
                {cashiers.map((cashier) => (
                  <option key={cashier.login} value={cashier.login}>
                    {cashier.displayName}
                  </option>
                ))}
              </select>
            </label>
            <ClientCodeField required={false} value={draft.clientCode} onChange={(clientCode) => change({ clientCode })} />
            <button type="button" className="secondary reset" onClick={() => setDraft(startingDraft(today))}>
              Сбросить
            </button>
          </div>
        </details>
      )}

      <p className="period">{shownPeriod}</p>

      {periodIsBackwards && (
        <p className="error" role="alert">
          Начало периода позже его конца.
        </p>
      )}
      {periodIsIncomplete && (
        <p className="error" role="alert">
          {mode === "cashier" ? "Выберите день." : "Укажите начало и конец периода."}
        </p>
      )}

      {load.kind === "loading" && <p className="hint">Загрузка…</p>}

      {load.kind === "failed" && (
        <div className="card">
          <p className="error" role="alert">
            Не удалось загрузить журнал.
          </p>
          <button type="button" className="secondary" onClick={refresh}>
            Повторить
          </button>
        </div>
      )}

      {load.kind === "ready" && (
        <>
          {load.refreshFailed && (
            <p className="error" role="alert">
              Не удалось обновить журнал, показаны прежние данные.{" "}
              <button type="button" className="link" onClick={refresh}>
                Повторить
              </button>
            </p>
          )}
          {load.operations.length === 0 ? (
            <p className="hint">
              {mode === "cashier"
                ? `За ${formatDay(applied.from)} ваших записей нет.`
                : "По этим условиям записей нет."}
            </p>
          ) : (
            <table className="journal-table" aria-label="Журнал операций" aria-busy={load.stale}>
              <thead>
                <tr>
                  <th scope="col">Время (МСК)</th>
                  {mode === "viewer" && <th scope="col">Кассир</th>}
                  <th scope="col">Операция</th>
                  <th scope="col" className="amount">
                    Сумма
                  </th>
                  <th scope="col">Клиент и получатель</th>
                  <th scope="col">Комментарий</th>
                </tr>
              </thead>
              <tbody className={load.stale ? "stale" : undefined}>
                {load.operations.map((operation) => (
                  <OperationRow
                    key={operation.id}
                    operation={operation}
                    mode={mode}
                    labels={labels}
                    takeFocus={operation.id === focusId}
                  />
                ))}
              </tbody>
            </table>
          )}

          {load.moreFailed && (
            <p className="error" role="alert">
              Не удалось загрузить остальное.
            </p>
          )}
          {load.nextCursor && (
            <button
              type="button"
              className="secondary"
              disabled={load.loadingMore || load.stale}
              onClick={loadMore}
            >
              {load.loadingMore ? "Загружаем…" : "Показать ещё"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function OperationRow({
  operation,
  mode,
  labels,
  takeFocus,
}: {
  operation: Operation;
  mode: Props["mode"];
  labels: Map<string, string>;
  /** The first row of a page just added: focus moves here so a keyboard user does not lose their place. */
  takeFocus: boolean;
}) {
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (takeFocus) row.current?.focus();
  }, [takeFocus]);
  const what = operation.type === "income" ? "Приход" : (labels.get(operation.category ?? "") ?? "Расход");
  const sign = operation.type === "income" ? "+" : "−";
  const details = [
    operation.clientCode && `Клиент ${operation.clientCode}`,
    operation.recipient && `Кому: ${operation.recipient}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <tr ref={row} tabIndex={takeFocus ? -1 : undefined} className={operation.type}>
      <td className="c-time">
        <time dateTime={operation.createdAt}>
          {mode === "cashier" ? formatMoscowClock(operation.createdAt) : formatMoscowShort(operation.createdAt)}
        </time>
      </td>
      {mode === "viewer" && <td className="c-who">{operation.author.displayName}</td>}
      <td className="c-what">{what}</td>
      <td className="c-amount">
        <span className={operation.type === "income" ? "money-in" : "money-out"}>
          {sign}
          {formatMoney(operation.amountMinor, operation.currency)}
        </span>
      </td>
      <td className="c-details">{details}</td>
      <td className="c-comment">{operation.comment}</td>
    </tr>
  );
}
