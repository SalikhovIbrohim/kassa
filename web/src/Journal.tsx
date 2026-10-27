import { KASSA_SHORT, scopeCurrencies, scopeKassa, useKassa } from "./kassa";
import { Icon } from "./sections";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  operationTitle,
  fetchCashiers,
  fetchCategories,
  fetchJournal,
  changeOneC,
  SessionExpiredError,
  type Balance,
  type Cashier,
  type Category,
  type JournalFilters,
  type OneCFilter,
  type OneCState,
  type Operation,
} from "./api";
import { ClientCodeField } from "./ClientCodeField";
import { DeleteConfirm } from "./DeleteConfirm";
import { HistoryPanel } from "./HistoryPanel";
import { OperationEditor } from "./OperationEditor";
import { formatDay, formatMoscowClock, formatMoscowShort, cashDayToday, shiftDay } from "./days";
import { CURRENCY_NAME, formatMoney, formatRate, type Currency } from "./money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Props = {
  /** A cashier looks at one day of everybody's entries (one book, one box of money); the viewer filters them. */
  mode: "cashier" | "viewer";
  /** The cashier who is signed in: only their own entries can be corrected or deleted, for a day after they were made. */
  login?: string;
  /** The admin corrects and deletes any entry, at any time. */
  isAdmin?: boolean;
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
  /** The admin's: what became of the entries in 1C. */
  onec: "" | OneCFilter;
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

/** How long the author may correct or delete their own entry; the server keeps the same rule. */
const OWN_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether the author's day to put the entry right is still running. */
function withinOwnDay(operation: Operation): boolean {
  return Date.now() - Date.parse(operation.createdAt) < OWN_CHANGE_WINDOW_MS;
}

function startingDraft(today: string): Draft {
  return { from: today, to: today, currency: "", type: "", category: "", clientCode: "", author: "", deleted: "", onec: "" };
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
    onec: draft.onec || undefined,
  };
}

export function Journal({ mode, login, isAdmin = false, onSessionExpired, onRefresh, onBalances, onOperationChanged }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = cashDayToday();
  const { scope } = useKassa();
  const kassa = scopeKassa(scope);
  const [draft, setDraft] = useState<Draft>(() => startingDraft(today));
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

  useEffect(() => {
    const complete = draft.from !== "" && draft.to !== "" && draft.from <= draft.to;
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
    // The cash desk chosen (or the person's own): the journal is of one desk at a time.
    const filters = { ...toFilters(applied), kassa };
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
  }, [applied, reloadCount, onSessionExpired, kassa]);

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
  /** A button of the column «1С» was pressed: the row says the new state at once. */
  function oneCChanged(id: string, state: OneCState) {
    setLoad((previous) =>
      previous.kind === "ready"
        ? { ...previous, operations: previous.operations.map((item) => (item.id === id ? { ...item, onec: state } : item)) }
        : previous,
    );
  }

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
    // It leaves the list (the admin, in «Управление», sees it again among the deleted ones when he asks for them).
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
  const periodIsBackwards = draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  const periodIsIncomplete = draft.from === "" || draft.to === "";
  const shownPeriod = applied.from === applied.to ? `За ${formatDay(applied.from)}` : `С ${formatDay(applied.from)} по ${formatDay(applied.to)}`;

  return (
    <section className="journal" aria-label="Журнал">
      <div className="journal-head">
        <h2 ref={heading} tabIndex={-1}>
          Журнал
        </h2>
        <Button type="button" variant="outline" size="sm" onClick={refresh}>
          Обновить
        </Button>
      </div>

      {mode === "cashier" ? (
        <div className="day-picker">
          <Button
            type="button"
            variant="outline" size="sm"
            aria-label="Предыдущий день"
            disabled={draft.from === ""}
            onClick={() => change({ from: shiftDay(draft.from, -1), to: shiftDay(draft.from, -1) })}
          >
            ←
          </Button>
          <Input
            type="date"
            aria-label="День"
            name="day"
            value={draft.from}
            max={today}
            onChange={(event) => change({ from: event.target.value, to: event.target.value })}
          />
          <Button
            type="button"
            variant="outline" size="sm"
            aria-label="Следующий день"
            disabled={draft.from === "" || draft.from >= today}
            onClick={() => change({ from: shiftDay(draft.from, 1), to: shiftDay(draft.from, 1) })}
          >
            →
          </Button>
        </div>
      ) : (
        <details className="filters" open={filtersOpen}>
          <summary>Фильтры</summary>
          <div className="filter-grid">
            <Label>
              С
              <Input type="date" name="from" aria-label="Период: с" value={draft.from} max={today} onChange={(e) => change({ from: e.target.value })} />
            </Label>
            <Label>
              По
              <Input type="date" name="to" aria-label="Период: по" value={draft.to} max={today} onChange={(e) => change({ to: e.target.value })} />
            </Label>
            <Label>
              Валюта
              <Select
                name="currency"
                value={draft.currency}
                onChange={(next) => change({ currency: next as Draft["currency"] })}
                options={[{ value: "", label: "Все" }, ...scopeCurrencies(scope).map((code) => ({ value: code, label: CURRENCY_NAME[code] }))]}
              />
            </Label>
            <Label>
              Тип
              <Select
                name="type"
                value={draft.type}
                onChange={(next) => change({ type: next as Draft["type"] })}
                options={[
                  { value: "", label: "Все" },
                  { value: "income", label: "Приход" },
                  { value: "expense", label: "Расход" },
                ]}
              />
            </Label>
            <Label>
              Категория
              <Select
                name="category"
                value={draft.category}
                onChange={(category) => change({ category })}
                options={[
                  { value: "", label: "Все" },
                  ...(["income", "expense"] as const).flatMap((kind) =>
                    categories
                      .filter((item) => item.kind === kind)
                      .map((item) => ({
                        value: item.code,
                        label: `${item.label}${item.archived ? " (в архиве)" : ""}`,
                        group: kind === "income" ? "Приход" : "Расход",
                      })),
                  ),
                ]}
              />
            </Label>
            <Label>
              Кассир
              <Select
                name="author"
                value={draft.author}
                onChange={(author) => change({ author })}
                options={[{ value: "", label: "Все" }, ...cashiers.map((cashier) => ({ value: cashier.login, label: cashier.displayName }))]}
              />
            </Label>
            <Label className="whole-line-on-phone">
              Удалённые записи
              <Select
                name="deleted"
                value={draft.deleted}
                onChange={(next) => change({ deleted: next as Draft["deleted"] })}
                options={[
                  { value: "", label: "Скрывать" },
                  { value: "include", label: "Показывать" },
                  { value: "only", label: "Только удалённые" },
                ]}
              />
            </Label>
            {isAdmin && (
              <Label className="whole-line-on-phone">
                1С
                <Select
                  name="onec"
                  value={draft.onec}
                  onChange={(next) => change({ onec: next as Draft["onec"] })}
                  options={[
                    { value: "", label: "Все" },
                    { value: "problem", label: "Ошибки и ждут" },
                    { value: "waiting", label: "В очереди" },
                    { value: "written", label: "Записаны" },
                    { value: "none", label: "Не отправлялись" },
                  ]}
                />
              </Label>
            )}
            <ClientCodeField required={false} value={draft.clientCode} onChange={(clientCode) => change({ clientCode })} />
            <Button type="button" variant="outline" className="reset" onClick={() => setDraft(startingDraft(today))}>
              Сбросить
            </Button>
          </div>
        </details>
      )}

      {/* The cashier sees the day in the date field right above: said once is enough. */}
      {mode !== "cashier" && <p className="period">{shownPeriod}</p>}

      {notice && (
        <p className={cn(alertVariants({ variant: "info" }), "notice")} role="status">
          {notice}
        </p>
      )}
      {categoriesFailed && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Не удалось загрузить названия категорий.{" "}
          <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={loadCategories}>
            Повторить
          </Button>
        </p>
      )}

      {periodIsBackwards && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Начало периода позже его конца.
        </p>
      )}
      {periodIsIncomplete && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {mode === "cashier" ? "Выберите день." : "Укажите начало и конец периода."}
        </p>
      )}

      {load.kind === "loading" && <p className="hint">Загрузка…</p>}

      {load.kind === "failed" && (
        <Card className="gap-3 p-4">
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить журнал.
          </p>
          <Button type="button" variant="outline" onClick={refresh}>
            Повторить
          </Button>
        </Card>
      )}

      {load.kind === "ready" && (
        <>
          {load.refreshFailed && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              Не удалось обновить журнал, показаны прежние данные.{" "}
              <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={refresh}>
                Повторить
              </Button>
            </p>
          )}
          {load.operations.length === 0 ? (
            <p className="hint">
              {mode === "cashier" ? "Записей нет." : "По этим условиям записей нет."}
            </p>
          ) : (
            <table className="journal-table" aria-label="Журнал операций" aria-busy={load.stale}>
              <thead>
                <tr>
                  <th scope="col">Время (МСК)</th>
                  <th scope="col">Кассир</th>
                  <th scope="col">Операция</th>
                  {/* A phone shows one amount in its card; a computer gives incomes, expenses and the rate a column each. */}
                  <th scope="col" className="amount min-[960px]:hidden">
                    Сумма
                  </th>
                  <th scope="col" className="amount max-[959px]:hidden">
                    Приход
                  </th>
                  <th scope="col" className="amount max-[959px]:hidden">
                    Расход
                  </th>
                  <th scope="col" className="amount max-[959px]:hidden">
                    Курс
                  </th>
                  <th scope="col" className="min-[960px]:hidden">Клиент и получатель</th>
                  <th scope="col" className="min-[960px]:hidden">Комментарий</th>
                  {/* On a computer both share one column, so that every row stays one line. */}
                  <th scope="col" className="max-[959px]:hidden">Подробности</th>
                  {isAdmin && <th scope="col">1С</th>}
                  <th scope="col" className="actions">
                    <span className="sr-only">{mode === "cashier" || isAdmin ? "Действия" : "История"}</span>
                  </th>
                </tr>
              </thead>
              <tbody className={load.stale ? "stale" : undefined}>
                {load.operations.map((operation) => {
                  const open = panel?.id === operation.id ? panel.kind : null;
                  const columns = isAdmin ? 10 : 9;
                  const description = describe(operation, labels);
                  return (
                    <Fragment key={operation.id}>
                      <OperationRow
                        markKassa={scope === "both"}
                        operation={operation}
                        mode={mode}
                        withDate={mode === "viewer"}
                        canChange={
                          operation.deletedAt === null &&
                          (isAdmin || (mode === "cashier" && login !== undefined && operation.author.login.toLowerCase() === login.toLowerCase() && withinOwnDay(operation)))
                        }
                        labels={labels}
                        description={description}
                        open={open}
                        onToggle={(kind) => togglePanel(kind, operation.id)}
                        focusRequest={focusRequest?.id === operation.id ? focusRequest : null}
                        onFocusDone={focusDone}
                        oneC={isAdmin ? <OneCCell operation={operation} onSessionExpired={onSessionExpired} onChanged={(state) => oneCChanged(operation.id, state)} /> : null}
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
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              Не удалось загрузить остальное.
            </p>
          )}
          {load.nextCursor && (
            <Button
              type="button"
              variant="outline"
              disabled={load.loadingMore || load.stale}
              onClick={loadMore}
            >
              {load.loadingMore ? "Загружаем…" : "Показать ещё"}
            </Button>
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
  canChange,
  labels,
  description,
  open,
  onToggle,
  focusRequest,
  onFocusDone,
  markKassa,
  oneC,
}: {
  operation: Operation;
  /** Both desks are shown: each entry says which one it is of (МСК, АНД). */
  markKassa: boolean;
  mode: Props["mode"];
  /** The day is shown with the time (a period of several days). */
  withDate: boolean;
  /** The cashier may correct or delete it: it is their own. */
  canChange: boolean;
  labels: Map<string, string>;
  description: string;
  open: Panel["kind"] | null;
  onToggle: (kind: Panel["kind"]) => void;
  /** Set when keyboard focus should move to this row (after an action), so nobody loses their place. */
  focusRequest: { id: string; nonce: number } | null;
  onFocusDone: () => void;
  /** The admin's column «1С»; null for everybody else. */
  oneC: ReactNode;
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
    operation.tripNumber && `Рейс ${operation.tripNumber}`,
    operation.counterparty && `Контрагент: ${operation.counterparty}`,
    operation.employee && `Сотрудник: ${operation.employee}`,
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
        {markKassa && (
          <span className="kassa-mark mr-1.5 rounded-full bg-primary px-1.5 py-px text-[10.5px] font-bold tracking-wide text-primary-foreground" title={operation.kassa === "andijan" ? "Андижан" : "Москва"}>
            {KASSA_SHORT[operation.kassa ?? "moscow"]}
          </span>
        )}
        <time dateTime={operation.createdAt}>
          {withDate ? formatMoscowShort(operation.createdAt) : formatMoscowClock(operation.createdAt)}
        </time>
      </td>
      {/* On a phone the buttons of one's own entry take the corner where the name stands; the name is one's own anyway. */}
      <td className={cn("c-who min-[720px]:whitespace-nowrap", canChange && "max-[719px]:invisible")}>{operation.author.displayName}</td>
      <td className="c-what">
        {what}{" "}
        {deleted ? (
          <>
            <Badge variant="destructive" className="deleted">удалена</Badge>
            {operation.deletedBy && (
              <span className="deleted-note">
                {operation.deletedBy.displayName}, {formatMoscowShort(operation.deletedAt!)}
              </span>
            )}
          </>
        ) : (
          operation.revision > 0 && <Badge variant="secondary" className="edited">изменена</Badge>
        )}
      </td>
      <td className="c-amount min-[960px]:hidden">
        <span className={operation.type === "income" ? "money-in" : "money-out"}>
          {sign}
          {formatMoney(operation.amountMinor, operation.currency)}
        </span>
        <DollarNote operation={operation} />
      </td>
      <td className="c-in max-[959px]:hidden">
        {operation.type === "income" && <span className="money-in">+{formatMoney(operation.amountMinor, operation.currency)}</span>}
      </td>
      <td className="c-out max-[959px]:hidden">
        {operation.type === "expense" && <span className="money-out">−{formatMoney(operation.amountMinor, operation.currency)}</span>}
      </td>
      <td className="c-rate max-[959px]:hidden">
        <RateCell operation={operation} />
      </td>
      <td className="c-details min-[960px]:hidden">{details}</td>
      <td className="c-comment min-[960px]:hidden">{operation.comment}</td>
      <td className="c-more max-[959px]:hidden" title={[details, operation.comment].filter(Boolean).join(" · ") || undefined}>
        {details}
        {details && operation.comment && " · "}
        {operation.comment && <span className="text-muted-foreground">{operation.comment}</span>}
      </td>
      {oneC !== null && <td className="c-onec">{oneC}</td>}
      <td className={mode === "cashier" ? "c-actions corner" : "c-actions"}>
        {canChange && (
          <>
            {/* On a computer two round icons, so that the row (with the admin's column «1С») fits; words on a phone's card. */}
            <Button
              type="button"
              variant="outline" size="sm"
              className="min-[960px]:size-9 min-[960px]:p-0"
              title="Изменить"
              aria-expanded={open === "edit"}
              aria-label={`Изменить: ${description}`}
              onClick={() => onToggle("edit")}
            >
              <Icon name="edit" size={17} className="max-[959px]:hidden" />
              <span className="min-[960px]:hidden">Изменить</span>
            </Button>
            <Button
              type="button"
              variant="outline" size="sm"
              className="min-[960px]:size-9 min-[960px]:p-0"
              title="Удалить"
              aria-expanded={open === "delete"}
              aria-label={`Удалить: ${description}`}
              onClick={() => onToggle("delete")}
            >
              <Icon name="trash" size={17} className="max-[959px]:hidden" />
              <span className="min-[960px]:hidden">Удалить</span>
            </Button>
          </>
        )}
        {mode === "viewer" && operation.revision > 0 && (
          <Button
            type="button"
            variant="outline" size="sm"
            aria-expanded={open === "history"}
            aria-label={`История: ${description}`}
            onClick={() => onToggle("history")}
          >
            История
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * The rate of a ruble entry in its own column: its own, or the average of its day (marked «ср.»). What it comes to
 * in dollars shows when the mouse rests on it, so that the row stays one line.
 */
function RateCell({ operation }: { operation: Operation }) {
  if (operation.currency !== "RUB") return null;
  if (operation.usdMinor === null) {
    return operation.type === "expense" ? <span className="text-muted-foreground" title="В этот день ещё нет прихода с курсом">нет курса</span> : null;
  }
  const dollars = `≈ ${formatMoney(operation.usdMinor, "USD")}`;
  if (operation.rateSource === "own" && operation.rateE4 !== null) {
    return <span title={dollars}>{formatRate(operation.rateE4)}</span>;
  }
  // The average of the day, as the entry was counted at it: rubles over the dollars they came to.
  // Shown to the kopeck, as people say a rate; the exact one is what the dollars were counted at.
  const rateE4 = Math.round((operation.amountMinor * 100) / operation.usdMinor) * 100;
  return (
    <span title={`${dollars} · средний курс дня`}>
      {formatRate(rateE4)} <span className="text-muted-foreground">ср.</span>
    </span>
  );
}

/** What a ruble entry is in dollars, and at which rate: its own, or the average of its day. */
function DollarNote({ operation }: { operation: Operation }) {
  if (operation.currency !== "RUB") return null;
  if (operation.usdMinor === null) {
    // An expense without a rate of its own is counted at the average of the incomes of its day: none had a rate yet.
    return operation.type === "expense" ? <small className="usd-note">в долларах: нет прихода с курсом</small> : null;
  }
  return (
    <small className="usd-note" data-usd={operation.usdMinor}>
      ≈ {formatMoney(operation.usdMinor, "USD")}
      {operation.rateSource === "own" && operation.rateE4 !== null && <> · курс {formatRate(operation.rateE4)}</>}
      {operation.rateSource === "day" && <> · средний курс дня</>}
    </small>
  );
}

/** How each state of the queue of 1C reads in the column «1С», and its color. */
const ONEC_LOOK: Record<OneCState["status"], { label: string; tone: string }> = {
  written: { label: "Записан", tone: "bg-success-bg text-success" },
  pending: { label: "В очереди", tone: "bg-muted text-muted-foreground" },
  blocked: { label: "Ждёт", tone: "bg-warning-bg text-warning" },
  failed: { label: "Ошибка", tone: "bg-destructive-bg text-destructive" },
  skipped: { label: "Не записан", tone: "bg-muted text-muted-foreground" },
  preview: { label: "Репетиция", tone: "bg-muted text-muted-foreground" },
  removed: { label: "Удалён в 1С", tone: "bg-muted text-muted-foreground" },
};

/** A payment of a client of the Moscow desk: what goes to 1C (the server keeps the same rule, see onec.ts). */
const isForOneC = (operation: Operation) =>
  operation.type === "income" && (operation.category === null || operation.category === "client_payment") && (operation.kassa ?? "moscow") === "moscow";

/**
 * The admin's column «1С»: what became of the entry in 1C, why when it is not written, and the two things he can do
 * about it: «Повторить» (back in the queue) and «Не записывать». Corrections and deletions reach 1C by themselves.
 */
function OneCCell({ operation, onSessionExpired, onChanged }: { operation: Operation; onSessionExpired: () => void; onChanged: (state: OneCState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = operation.onec ?? null;

  if (state === null) {
    if (!isForOneC(operation) || operation.deletedAt !== null) return null;
    return (
      <span className="onec-state text-muted-foreground" data-onec="none" title="Внесён, когда запись в 1С была выключена: в 1С его нет">
        Не отправлялся
      </span>
    );
  }

  const look = ONEC_LOOK[state.status];
  const canRetry = ["failed", "blocked", "skipped", "preview"].includes(state.status);
  const canSkip = ["pending", "blocked", "failed", "preview"].includes(state.status);
  const what = `${operation.clientCode ?? "приход"} ${formatMoney(operation.amountMinor, operation.currency)}`;

  async function act(action: "retry" | "skip") {
    setBusy(true);
    setError(null);
    try {
      const result = await changeOneC(state!.id, action);
      if (result.ok) {
        onChanged(action === "retry" ? { ...state!, status: "pending", detail: null, attempts: 0 } : { ...state!, status: "skipped", detail: "пропущен вручную" });
      } else {
        setError(result.reason === "wrong-state" ? "Состояние уже другое: нажмите «Обновить»." : "Не получилось, попробуйте ещё раз.");
      }
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setError("Нет связи, попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="onec-state grid gap-1" data-onec={state.status}>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full px-2 py-px text-[12px] font-semibold whitespace-nowrap", look.tone)}>{look.label}</span>
        {state.docNumber && <span className="text-[13px] whitespace-nowrap">ПКО №{state.docNumber}</span>}
        {state.status === "pending" && state.attempts > 0 && <span className="text-[12px] text-muted-foreground">попытка {state.attempts + 1}</span>}
      </span>
      {state.detail && state.status !== "written" && <span className="onec-detail text-[12.5px] leading-snug text-muted-foreground">{state.detail}</span>}
      {(canRetry || canSkip) && (
        <span className="flex flex-wrap gap-1.5">
          {canRetry && (
            <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={busy} aria-label={`Повторить запись в 1С: ${what}`} onClick={() => void act("retry")}>
              Повторить
            </Button>
          )}
          {canSkip && (
            <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={busy} aria-label={`Не записывать в 1С: ${what}`} onClick={() => void act("skip")}>
              Не записывать
            </Button>
          )}
        </span>
      )}
      {error && (
        <span className="text-[12.5px] text-destructive" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
