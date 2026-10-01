import { useEffect, useState } from "react";
import { fetchCategories, type Category } from "./api";
import { formatMoney, formatMoscowTime } from "./money";
import { plural } from "./plural";
import type { Problem, QueuedEntry } from "./queue";
import { queue, useQueueState } from "./queue-instance";

type Props = {
  /** The cashier signed in now. */
  login: string;
  /** Opens the login screen (the session has ended). */
  onSignIn: () => void;
};

const PROBLEM_TEXT = (problem: Problem): string => {
  switch (problem.kind) {
    case "insufficient-balance":
      return `В кассе не хватает денег: сейчас ${formatMoney(problem.availableMinor, problem.currency)}. Внесите недостающий приход и нажмите «Повторить».`;
    case "conflict":
      return "Этот номер записи уже занят другой записью на сервере. Проверьте журнал, возможно, она уже есть.";
    case "forbidden":
      return "У вас нет права вносить операции.";
    case "rejected":
      return "Сервер не принял данные этой записи.";
  }
};

/**
 * What is on the phone and not yet on the server: how many entries, whether they are going out, and
 * what to do about the ones the server refused. Nothing is shown when there is nothing to say.
 */
export function QueueBanner({ login, onSignIn }: Props) {
  const state = useQueueState();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  const mine = state.entries.filter((entry) => entry.login === login);
  const others = [...new Set(state.entries.filter((entry) => entry.login !== login).map((entry) => entry.login))];
  const waiting = mine.filter((entry) => entry.status === "waiting");
  const blocked = mine.filter((entry) => entry.status === "blocked");

  // Names of categories, for the list; without a connection the list simply goes without them.
  useEffect(() => {
    if (!open || categories.length > 0) return;
    fetchCategories().then(setCategories, () => {});
  }, [open, categories.length]);

  // A list that has nothing left to show closes itself.
  useEffect(() => {
    if (mine.length === 0) {
      setOpen(false);
      setRemoving(null);
    }
  }, [mine.length]);

  if (mine.length === 0 && others.length === 0) return null;

  const labelOf = (entry: QueuedEntry): string => {
    const input = entry.input;
    const sign = input.type === "income" ? "+" : "−";
    const kind =
      input.type === "income"
        ? "Приход"
        : (categories.find((item) => item.code === input.category)?.label ?? "Расход");
    const who = input.clientCode ? `, клиент ${input.clientCode}` : input.type === "expense" && input.recipient ? `, ${input.recipient}` : "";
    return `${kind} ${sign}${formatMoney(input.amountMinor, input.currency)}${who}`;
  };

  let status: string;
  if (state.needsLogin) status = "Нужно войти заново. Записи отправятся после входа.";
  else if (state.sending) status = "Отправляем…";
  else if (waiting.length > 0) {
    status = state.offline
      ? "Нет связи. Записи хранятся на телефоне и отправятся сами, как только она появится."
      : "Записи отправятся сами, как только получится.";
  } else status = "Сервер не принял эти записи. Нужно ваше решение.";

  return (
    <section className="queue" aria-label="Записи, которые ещё не дошли до сервера">
      {mine.length > 0 && (
        <>
          <p className="queue-title">
            Не отправлено: {mine.length} {plural(mine.length, "запись", "записи", "записей")}
          </p>
          <p className="queue-status" role="status">
            {status}
          </p>
          <div className="queue-actions">
            {state.needsLogin && (
              <button type="button" className="small" onClick={onSignIn}>
                Войти
              </button>
            )}
            {!state.needsLogin && waiting.length > 0 && (
              <button type="button" className="secondary small" disabled={state.sending} onClick={() => void queue.nudge()}>
                Отправить сейчас
              </button>
            )}
            <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Скрыть список" : "Показать список"}
            </button>
          </div>

          {(open || blocked.length > 0) && (
            <ul className="queue-list">
              {mine.map((entry) => (
                <li key={entry.id} className={entry.status === "blocked" ? "queue-entry blocked" : "queue-entry"}>
                  <span className="queue-entry-text">
                    <span className="when">{formatMoscowTime(entry.queuedAt)}</span> {labelOf(entry)}
                  </span>
                  {entry.status === "waiting" && <span className="queue-entry-state">ждёт отправки</span>}
                  {entry.problem && <span className="queue-problem">{PROBLEM_TEXT(entry.problem)}</span>}
                  {entry.status === "blocked" && (
                    <span className="queue-entry-actions">
                      {removing === entry.id ? (
                        <>
                          <span className="queue-warning">
                            Точно убрать? Эта запись нигде не будет учтена: деньги по ней придётся записать заново.
                          </span>
                          <button
                            type="button"
                            className="danger small"
                            onClick={() => {
                              setRemoving(null);
                              void queue.discard(entry.id);
                            }}
                          >
                            Да, убрать
                          </button>
                          <button type="button" className="secondary small" onClick={() => setRemoving(null)}>
                            Отмена
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="small" onClick={() => void queue.retry(entry.id)}>
                            Повторить
                          </button>
                          <button type="button" className="secondary small" onClick={() => setRemoving(entry.id)}>
                            Убрать
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {others.length > 0 && (
        <p className="queue-others">
          На этом телефоне ждут входа другого кассира ({others.join(", ")}). Их записи отправятся после его входа.
        </p>
      )}
    </section>
  );
}
