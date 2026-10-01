import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCashiers,
  fetchCategories,
  fetchJournal,
  SessionExpiredError,
  type Balance,
  type Cashier,
  type Category,
  type JournalFilters,
  type Operation,
} from "./api";
import { ClientCodeField } from "./ClientCodeField";
import { DeleteConfirm } from "./DeleteConfirm";
import { HistoryPanel } from "./HistoryPanel";
import { OperationEditor } from "./OperationEditor";
import { formatDay, formatMoscowClock, formatMoscowShort, moscowToday, shiftDay } from "./days";
import { CURRENCIES, CURRENCY_NAME, formatMoney, type Currency } from "./money";

type Props = {
  /** A cashier looks at one day of their own operations; the viewer filters everyone's. */
  mode: "cashier" | "viewer";
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh?: () => void;
  /** Called with the new balances after a correction or deletion changed them. */
  onBalances?: (balances: Balance[]) => void;
};

/** What is open under a row: a correction, a deletion to confirm, or the history. */
type Panel = { kind: "edit" | "delete" | "history"; id: string };

/** What the filter controls hold. Empty text means "any". */
type Draft = {
  from: string;
  to: string;
  currency: "" | Currency;
  type: "" | "income" | "expense";
  category: string;
  clientCode: string;
  author: string;
  deleted: "" | "include" | "only";
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
  return { from: today, to: today, currency: "", type: "", category: "", clientCode: "", author: "", deleted: "" };
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
    deleted: draft.deleted || undefined,
  };
}

export function Journal({ mode, onSessionExpired, onRefresh, onBalances }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = moscowToday();
  const [draft, setDraft] = useState<Draft>(() => startingDraft(today));
  // Laptops start with the filters open, phones with them folded; the person's choice sticks.
  const [filtersOpen] = useState(() => window.matchMedia("(min-width: 720px)").matches);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
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

  /** Opens a panel under a row, or closes it when the same button is pressed again. */
  const togglePanel = (kind: Panel["kind"], id: string) =>
    setPanel((current) => (current?.kind === kind && current.id === id ? null : { kind, id }));

  function operationChanged(changed: Operation, balances: Balance[]) {
    setPanel(null);
    setFocusId(changed.id);
    setLoad((previous) =>
      previous.kind === "ready"
        ? { ...previous, operations: previous.operations.map((item) => (item.id === changed.id ? changed : item)) }
        : previous,
    );
    onBalances?.(balances);
  }

  function operationDeleted(deleted: Operation, balances: Balance[]) {
    setPanel(null);
    // A cashier no longer sees it. (The viewer never deletes.)
    setLoad((previous) =>
      previous.kind === "ready"
        ? { ...previous, operations: previous.operations.filter((item) => item.id !== deleted.id) }
        : previous,
    );
    onBalances?.(balances);
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
            <label>
              Удалённые записи
              <select name="deleted" value={draft.deleted} onChange={(e) => change({ deleted: e.target.value as Draft["deleted"] })}>
                <option value="">Скрывать</option>
                <option value="include">Показывать</option>
                <option value="only">Только удалённые</option>
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
                  <th scope="col" className="actions">
                    <span className="sr-only">{mode === "cashier" ? "Действия" : "История"}</span>
                  </th>
                </tr>
              </thead>
              <tbody className={load.stale ? "stale" : undefined}>
                {load.operations.map((operation) => {
                  const open = panel?.id === operation.id ? panel.kind : null;
                  const columns = mode === "viewer" ? 7 : 6;
                  const description = describe(operation, labels);
                  return (
                    <Fragment key={operation.id}>
                      <OperationRow
                        operation={operation}
                        mode={mode}
                        labels={labels}
                        description={description}
                        open={open}
                        onToggle={(kind) => togglePanel(kind, operation.id)}
                        takeFocus={operation.id === focusId}
                      />
                      {open && (
                        <tr className="panel">
                          <td colSpan={columns}>
                            {open === "edit" && (
                              <OperationEditor
                                operation={operation}
                                categories={categories}
                                onSaved={operationChanged}
                                onCancel={() => setPanel(null)}
                                onSessionExpired={onSessionExpired}
                              />
                            )}
                            {open === "delete" && (
                              <DeleteConfirm
                                operation={operation}
                                description={description}
                                onDeleted={operationDeleted}
                                onCancel={() => setPanel(null)}
                                onSessionExpired={onSessionExpired}
                              />
                            )}
                            {open === "history" && (
                              <HistoryPanel
                                operationId={operation.id}
                                labels={labels}
                                onClose={() => setPanel(null)}
                                onSessionExpired={onSessionExpired}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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

/** The operation in words, for a question or a button: "Приход +1 500,00 ₽". */
function describe(operation: Operation, labels: Map<string, string>): string {
  const what = operation.type === "income" ? "Приход" : (labels.get(operation.category ?? "") ?? "Расход");
  const sign = operation.type === "income" ? "+" : "−";
  return `${what} ${sign}${formatMoney(operation.amountMinor, operation.currency)}`;
}

function OperationRow({
  operation,
  mode,
  labels,
  description,
  open,
  onToggle,
  takeFocus,
}: {
  operation: Operation;
  mode: Props["mode"];
  labels: Map<string, string>;
  description: string;
  open: Panel["kind"] | null;
  onToggle: (kind: Panel["kind"]) => void;
  /** The row just added or changed: focus moves here so a keyboard user does not lose their place. */
  takeFocus: boolean;
}) {
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (takeFocus) row.current?.focus();
  }, [takeFocus]);
  const what = operation.type === "income" ? "Приход" : (labels.get(operation.category ?? "") ?? "Расход");
  const sign = operation.type === "income" ? "+" : "−";
  const deleted = operation.deletedAt !== null;
  const details = [
    operation.clientCode && `Клиент ${operation.clientCode}`,
    operation.recipient && `Кому: ${operation.recipient}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <tr
      ref={row}
      tabIndex={takeFocus ? -1 : undefined}
      className={[operation.type, deleted ? "deleted" : ""].filter(Boolean).join(" ")}
    >
      <td className="c-time">
        <time dateTime={operation.createdAt}>
          {mode === "cashier" ? formatMoscowClock(operation.createdAt) : formatMoscowShort(operation.createdAt)}
        </time>
      </td>
      {mode === "viewer" && <td className="c-who">{operation.author.displayName}</td>}
      <td className="c-what">
        {what}{" "}
        {deleted ? (
          <>
            <span className="badge deleted">удалена</span>
            {operation.deletedBy && (
              <span className="deleted-note">
                {operation.deletedBy.displayName}, {formatMoscowShort(operation.deletedAt!)}
              </span>
            )}
          </>
        ) : (
          operation.revision > 0 && <span className="badge edited">изменена</span>
        )}
      </td>
      <td className="c-amount">
        <span className={operation.type === "income" ? "money-in" : "money-out"}>
          {sign}
          {formatMoney(operation.amountMinor, operation.currency)}
        </span>
      </td>
      <td className="c-details">{details}</td>
      <td className="c-comment">{operation.comment}</td>
      <td className={mode === "cashier" ? "c-actions corner" : "c-actions"}>
        {mode === "cashier" && (
          <>
            <button
              type="button"
              className="secondary small"
              aria-expanded={open === "edit"}
              aria-label={`Изменить: ${description}`}
              onClick={() => onToggle("edit")}
            >
              Изменить
            </button>
            <button
              type="button"
              className="secondary small"
              aria-expanded={open === "delete"}
              aria-label={`Удалить: ${description}`}
              onClick={() => onToggle("delete")}
            >
              Удалить
            </button>
          </>
        )}
        {mode === "viewer" && operation.revision > 0 && (
          <button
            type="button"
            className="secondary small"
            aria-expanded={open === "history"}
            aria-label={`История: ${description}`}
            onClick={() => onToggle("history")}
          >
            История
          </button>
        )}
      </td>
    </tr>
  );
}
