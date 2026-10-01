import { useEffect, useState } from "react";
import { fetchHistory, SessionExpiredError, type OperationHistory, type Snapshot } from "./api";
import { formatMoscowShort } from "./days";
import { formatMoney, formatRate } from "./money";
import { usePanelEntrance } from "./usePanelEntrance";

type Props = {
  operationId: string;
  /** Category code to the words people read. */
  labels: Map<string, string>;
  onClose: () => void;
  onSessionExpired: () => void;
};

type State = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; history: OperationHistory };

const EMPTY = "ничего";

/** What differs between two versions of an operation, as lines a person can read. */
export function describeChange(before: Snapshot, after: Snapshot, labels: Map<string, string>) {
  const lines: Array<{ field: string; before: string; after: string }> = [];
  const text = (value: string | null) => value ?? EMPTY;
  const category = (code: string | null) => (code === null ? EMPTY : (labels.get(code) ?? code));

  if (before.amountMinor !== after.amountMinor || before.currency !== after.currency) {
    lines.push({
      field: "Сумма",
      before: formatMoney(before.amountMinor, before.currency),
      after: formatMoney(after.amountMinor, after.currency),
    });
  }
  if (before.rateE4 !== after.rateE4) {
    const rate = (value: number | null) => (value === null ? EMPTY : formatRate(value));
    lines.push({ field: "Курс", before: rate(before.rateE4), after: rate(after.rateE4) });
  }
  if (before.category !== after.category) {
    lines.push({ field: "Категория", before: category(before.category), after: category(after.category) });
  }
  if (before.recipient !== after.recipient) {
    lines.push({ field: "Кому выдали", before: text(before.recipient), after: text(after.recipient) });
  }
  if (before.clientCode !== after.clientCode) {
    lines.push({ field: "Код клиента", before: text(before.clientCode), after: text(after.clientCode) });
  }
  if (before.comment !== after.comment) {
    lines.push({ field: "Комментарий", before: text(before.comment), after: text(after.comment) });
  }
  return lines;
}

/** The whole story of one operation: how it was written, then every change, oldest first. */
export function HistoryPanel({ operationId, labels, onClose, onSessionExpired }: Props) {
  const { root, heading } = usePanelEntrance<HTMLElement>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    fetchHistory(operationId).then(
      (history) => current && setState({ kind: "ready", history }),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setState({ kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [operationId, attempt, onSessionExpired]);

  return (
    <section className="panel-body history" aria-label="История записи" ref={root}>
      <h3 ref={heading} tabIndex={-1}>
        История записи
      </h3>

      {state.kind === "loading" && <p className="hint">Загрузка…</p>}

      {state.kind === "failed" && (
        <>
          <p className="error" role="alert">
            Не удалось загрузить историю.
          </p>
          <button type="button" className="secondary" onClick={() => setAttempt((count) => count + 1)}>
            Повторить
          </button>
        </>
      )}

      {state.kind === "ready" && <HistoryList history={state.history} labels={labels} />}

      <div className="panel-buttons">
        <button type="button" className="secondary" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </section>
  );
}

function HistoryList({ history, labels }: { history: OperationHistory; labels: Map<string, string> }) {
  const { operation, created, changes } = history;
  const kind = operation.type === "income" ? "Приход" : "Расход";
  const written = [
    `${kind} ${formatMoney(created.state.amountMinor, created.state.currency)}`,
    created.state.category && (labels.get(created.state.category) ?? created.state.category),
    created.state.clientCode && `клиент ${created.state.clientCode}`,
    created.state.recipient && `кому: ${created.state.recipient}`,
    created.state.comment && `«${created.state.comment}»`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <ol className="history-list">
      <li>
        <strong>
          {formatMoscowShort(created.at)}, {created.by.displayName}
        </strong>
        <span>Записано: {written}.</span>
      </li>
      {changes.map((change) => (
        <li key={change.revision}>
          <strong>
            {formatMoscowShort(change.at)}, {change.by.displayName}
          </strong>
          {change.action === "delete" ? (
            <span>Запись удалена.</span>
          ) : (
            <ul className="history-diff">
              {describeChange(change.before, change.after, labels).map((line) => (
                <li key={line.field}>
                  {line.field}: <s>{line.before}</s> → <b>{line.after}</b>
                </li>
              ))}
            </ul>
          )}
          {change.reason && <span className="reason">Причина: {change.reason}</span>}
        </li>
      ))}
      {operation.deletedAt === null && changes.length === 0 && <li className="hint">Запись не менялась.</li>}
    </ol>
  );
}

