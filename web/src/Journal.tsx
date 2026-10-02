import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  operationTitle,
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
import { CURRENCIES, CURRENCY_NAME, formatMoney, formatRate, type Currency } from "./money";

type Props = {
  /** A cashier looks at one day, or one shift, of their own operations; the viewer filters everyone's. */
  mode: "cashier" | "viewer";
  /** The cashier has a shift open: their journal starts with its operations. */
  shiftOpen?: boolean;
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh?: () => void;
  /** Called with the new balances after a correction or deletion changed them. */
  onBalances?: (balances: Balance[]) => void;
  /** Called with an operation the cashier just corrected or deleted. */
  onOperationChanged?: (operation: Operation) => void;
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
  /** "current": the operations of the open shift, whatever the day. */
  shift: "" | "current";
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

function startingDraft(today: string, shift: Draft["shift"] = ""): Draft {
  return { from: today, to: today, currency: "", type: "", category: "", clientCode: "", author: "", deleted: "", shift };
}

function toFilters(draft: Draft): JournalFilters {
  return {
    from: draft.shift ? undefined : draft.from,
    to: draft.shift ? undefined : draft.to,
    shift: draft.shift || undefined,
    currency: draft.currency || undefined,
    type: draft.type || undefined,
    category: draft.category || undefined,
    clientCode: draft.clientCode.trim() || undefined,
    author: draft.author || undefined,
    deleted: draft.deleted || undefined,
  };
}

export function Journal({ mode, shiftOpen = false, onSessionExpired, onRefresh, onBalances, onOperationChanged }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = moscowToday();
  const [draft, setDraft] = useState<Draft>(() => startingDraft(today, mode === "cashier" && shiftOpen ? "current" : ""));
  // Laptops start with the filters open, phones with them folded; the person's choice sticks.
  const [filtersOpen] = useState(() => window.matchMedia("(min-width: 720px)").matches);
  const [panel, setPanel] = useState<Panel | null>(null);
  // Where keyboard focus should go next: a row (after an action) or nothing. A request is
  // handed over once and forgotten, so that a row appearing later cannot take focus again.
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [categoriesFailed, setCategoriesFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // What the list was asked for. It follows the draft at once, except while text is typed.
  const [applied, setApplied] = useState<Draft>(draft);
  const [reloadCount, setReloadCount] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [categories, setCategories] = useState<Category[]>([]);
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  // Numbers the requests, so only the newest answer may update the screen.
  const newest = useRef(0);

  const loadCategories = useCallback(() => {
    fetchCategories().then(
      (list) => {
        setCategories(list);
        setCategoriesFailed(false);
      },
      (caught: unknown) => {
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setCategoriesFailed(true);
      },
    );
  }, [onSessionExpired]);

  useEffect(() => {
    loadCategories();
    if (mode === "viewer") fetchCashiers().then(setCashiers);
  }, [mode, loadCategories]);

  // The shift was closed while its operations are on show: back to the day.
  useEffect(() => {
    if (!shiftOpen) setDraft((previous) => (previous.shift ? { ...previous, shift: "" } : previous));
  }, [shiftOpen]);

  useEffect(() => {
    const complete = draft.shift !== "" || (draft.from !== "" && draft.to !== "" && draft.from <= draft.to);
    if (!complete) return;
    const pause = draft.clientCode === applied.clientCode ? 0 : TYPING_PAUSE_MS;
    const timer = setTimeout(() => setApplied(draft), pause);
    return () => clearTimeout(timer);
  }, [draft, applied.clientCode]);

  // The handlers below run after a render and need the panel and the list as they are now,
  // not as they were when the request that they answer was sent.
  const panelNow = useRef<Panel | null>(null);
  const loadNow = useRef<Load>(load);
  useEffect(() => {
    panelNow.current = panel;
    loadNow.current = load;
  });

  // A panel belongs to a row of the list on screen: new filters or a row that is gone close it.
  useEffect(() => {
    setPanel(null);
    setNotice(null);
  }, [applied]);
  useEffect(() => {
    if (panel && load.kind === "ready" && !load.stale && !load.operations.some((item) => item.id === panel.id)) {
      setPanel(null);
    }
  }, [load, panel]);

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
      if (page.operations[0]) requestFocus(page.operations[0].id);
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

  const requestFocus = useCallback((id: string) => {
    focusNonce.current += 1;
    setFocusRequest({ id, nonce: focusNonce.current });
  }, []);
  const focusDone = useCallback(() => setFocusRequest(null), []);

  /** Opens a panel under a row, or closes it when the same button is pressed again. */
  const togglePanel = (kind: Panel["kind"], id: string) => {
    setNotice(null);
    setPanel((current) => (current?.kind === kind && current.id === id ? null : { kind, id }));
  };

  /** Closes the open panel without doing anything, and puts keyboard focus back on its row. */
  function closePanel() {
    const open = panelNow.current;
    setPanel(null);
    if (open) requestFocus(open.id);
  }

  function operationChanged(changed: Operation, balances: Balance[]) {
    // Only the panel this answer belongs to closes: the person may be working in another one by now.
    const answered = panelNow.current?.id === changed.id;
    if (answered) {
      setPanel(null);
      requestFocus(changed.id);
    }
    setLoad((previous) =>
      previous.kind === "ready"
        ? { ...previous, operations: previous.operations.map((item) => (item.id === changed.id ? changed : item)) }
        : previous,
    );
    onBalances?.(balances);
    onOperationChanged?.(changed);
  }

  function operationDeleted(deleted: Operation, balances: Balance[]) {
    const answered = panelNow.current?.id === deleted.id;
    // Focus goes to the row that takes its place, or to the heading when the list is empty now.
    const rows = loadNow.current.kind === "ready" ? loadNow.current.operations : [];
    const index = rows.findIndex((item) => item.id === deleted.id);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    if (answered) {
      setPanel(null);
      if (neighbour) requestFocus(neighbour.id);
      else heading.current?.focus();
    }
    // A cashier no longer sees it. (The viewer never deletes.)
    setLoad((previous) =>
      previous.kind === "ready"
        ? { ...previous, operations: previous.operations.filter((item) => item.id !== deleted.id) }
        : previous,
    );
    onBalances?.(balances);
    onOperationChanged?.(deleted);
  }

  /** The operation was deleted somewhere else: close the panel, say so, and bring the screen up to date. */
  function operationGone(message: string) {
    setPanel(null);
    setNotice(message);
    refresh();
  }

  const labels = useMemo(() => new Map(categories.map((item) => [item.code, item.label])), [categories]);
  const change = (changes: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...changes }));
  const periodIsBackwards = draft.shift === "" && draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  const periodIsIncomplete = draft.shift === "" && (draft.from === "" || draft.to === "");
  const shownPeriod =
    applied.shift !== ""
      ? "Операции текущей смены"
      : applied.from === applied.to
      ? `За ${formatDay(applied.from)}`
      : `С ${formatDay(applied.from)} по ${formatDay(applied.to)}`;

  return (
    <section className="journal" aria-label="Журнал">
      <div className="journal-head">
        <h2 ref={heading} tabIndex={-1}>
          Журнал
        </h2>
        <button type="button" className="secondary small" onClick={refresh}>
          Обновить
        </button>
      </div>

      {mode === "cashier" && shiftOpen && (
        <div className="presets" role="group" aria-label="Что показывать">
          <button
            type="button"
            className={draft.shift === "current" ? "secondary small chosen" : "secondary small"}
            aria-pressed={draft.shift === "current"}
            onClick={() => change({ shift: "current" })}
          >
            Смена
          </button>
          <button
            type="button"
            className={draft.shift === "" ? "secondary small chosen" : "secondary small"}
            aria-pressed={draft.shift === ""}
            onClick={() => change({ shift: "" })}
          >
            День
          </button>
        </div>
      )}

      {mode === "cashier" ? (
        draft.shift === "" && (
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
        )
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
                {(["income", "expense"] as const).map((kind) => (
                  <optgroup key={kind} label={kind === "income" ? "Приход" : "Расход"}>
                    {categories
                      .filter((item) => item.kind === kind)
                      .map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                          {item.archived ? " (в архиве)" : ""}
                        </option>
                      ))}
                  </optgroup>
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
            <label className="whole-line-on-phone">
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

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {categoriesFailed && (
        <p className="error" role="alert">
          Не удалось загрузить названия категорий.{" "}
          <button type="button" className="link" onClick={loadCategories}>
            Повторить
          </button>
        </p>
      )}

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
                ? applied.shift !== ""
                  ? "В этой смене ваших записей пока нет."
                  : `За ${formatDay(applied.from)} ваших записей нет.`
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
                        withDate={mode === "viewer" || applied.shift !== ""}
                        labels={labels}
                        description={description}
                        open={open}
                        onToggle={(kind) => togglePanel(kind, operation.id)}
                        focusRequest={focusRequest?.id === operation.id ? focusRequest : null}
                        onFocusDone={focusDone}
                      />
                      {open && (
                        <tr className="panel">
                          <td colSpan={columns}>
                            {open === "edit" && (
                              <OperationEditor
                                operation={operation}
                                categories={categories}
                                onSaved={operationChanged}
                                onCancel={closePanel}
                                onSessionExpired={onSessionExpired}
                                onGone={operationGone}
                                onReloadCategories={loadCategories}
                              />
                            )}
                            {open === "delete" && (
                              <DeleteConfirm
                                operation={operation}
                                description={description}
                                onDeleted={operationDeleted}
                                onCancel={closePanel}
                                onSessionExpired={onSessionExpired}
                                onGone={operationGone}
                              />
                            )}
                            {open === "history" && (
                              <HistoryPanel
                                key={`${operation.id}-${operation.revision}-${operation.deletedAt ?? ""}`}
                                operationId={operation.id}
                                labels={labels}
                                onClose={closePanel}
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
  const what = operationTitle(operation.type, operation.category, labels);
  const sign = operation.type === "income" ? "+" : "−";
  return `${what} ${sign}${formatMoney(operation.amountMinor, operation.currency)}`;
}

function OperationRow({
  operation,
  mode,
  withDate,
  labels,
  description,
  open,
  onToggle,
  focusRequest,
  onFocusDone,
}: {
  operation: Operation;
  mode: Props["mode"];
  /** The day is shown with the time: a shift can go through midnight. */
  withDate: boolean;
  labels: Map<string, string>;
  description: string;
  open: Panel["kind"] | null;
  onToggle: (kind: Panel["kind"]) => void;
  /** Set when keyboard focus should move to this row (after an action), so nobody loses their place. */
  focusRequest: { id: string; nonce: number } | null;
  onFocusDone: () => void;
}) {
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    row.current?.focus();
    onFocusDone();
  }, [focusRequest, onFocusDone]);
  const what = operationTitle(operation.type, operation.category, labels);
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
      tabIndex={-1}
      className={[operation.type, deleted ? "deleted" : ""].filter(Boolean).join(" ")}
    >
      <td className="c-time">
        <time dateTime={operation.createdAt}>
          {withDate ? formatMoscowShort(operation.createdAt) : formatMoscowClock(operation.createdAt)}
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
        <DollarNote operation={operation} />
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

/** What a ruble entry is in dollars, and at which rate: its own, or the average of its shift. */
function DollarNote({ operation }: { operation: Operation }) {
  if (operation.currency !== "RUB") return null;
  if (operation.usdMinor === null) {
    // An expense without a rate of its own waits for the shift to be closed.
    return operation.type === "expense" ? <small className="usd-note">в долларах после закрытия смены</small> : null;
  }
  return (
    <small className="usd-note" data-usd={operation.usdMinor}>
      ≈ {formatMoney(operation.usdMinor, "USD")}
      {operation.rateSource === "own" && operation.rateE4 !== null && <> · курс {formatRate(operation.rateE4)}</>}
      {operation.rateSource === "shift" && <> · средний курс смены</>}
    </small>
  );
}
