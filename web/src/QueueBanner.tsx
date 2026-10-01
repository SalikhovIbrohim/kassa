import { useEffect, useState } from "react";
import { fetchCategories, type Category } from "./api";
import { plural } from "./plural";
import type { QueuedEntry } from "./queue";
import { queue, useQueueState } from "./queue-instance";
import { entryText, phoneTime, problemText } from "./queue-text";

type Props = {
  /** The cashier signed in now. */
  login: string;
  /** Opens the login screen (the session has ended). */
  onSignIn: () => void;
};

/**
 * What is on the phone and not yet on the server: how many entries, whether they are going out, what to
 * do about the ones the server refused, and the entries of another cashier that wait for them. Nothing
 * is shown when there is nothing to say.
 */
export function QueueBanner({ login, onSignIn }: Props) {
  const state = useQueueState();
  const [open, setOpen] = useState(false);
  const [openOthers, setOpenOthers] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  const mine = state.entries.filter((entry) => entry.login === login);
  const others = state.entries.filter((entry) => entry.login !== login);
  const otherLogins = [...new Set(others.map((entry) => entry.login))];
  const waiting = mine.filter((entry) => entry.status === "waiting");
  const blocked = mine.filter((entry) => entry.status === "blocked");

  // Names of categories, for the list; without a connection the phone's own copy of them is used.
  useEffect(() => {
    if (state.entries.length === 0 || categories.length > 0) return;
    fetchCategories().then(setCategories, () => {});
  }, [state.entries.length, categories.length]);

  // A list that has nothing left to show closes itself.
  useEffect(() => {
    if (mine.length === 0) setOpen(false);
    if (others.length === 0) setOpenOthers(false);
    if (removing && !state.entries.some((entry) => entry.id === removing)) setRemoving(null);
  }, [mine.length, others.length, removing, state.entries]);

  if (state.entries.length === 0) return null;

  let status: string;
  if (state.needsLogin) status = "Нужно войти заново. Записи уйдут после входа.";
  else if (state.sending) status = "Отправляем…";
  else if (waiting.length > 0) {
    status = state.offline
      ? "Нет связи с сервером. Записи на телефоне. Уйдут, когда связь появится и приложение будет открыто."
      : "Отправим, как только получится. Держите приложение открытым.";
  } else {
    status = `${blocked.length === 1 ? "Сервер не принял эту запись" : "Сервер не принял эти записи"}. Нужно ваше решение: «Отправить снова» или «Удалить с телефона».`;
  }

  return (
    <section id="queue" className="queue" aria-label="Записи, которые ещё не дошли до сервера">
      {mine.length > 0 && (
        <>
          <p className="queue-title">
            Не отправлено: {mine.length} {plural(mine.length, "запись", "записи", "записей")}
          </p>
          <p className="queue-status" role="status">
            {status}
          </p>
          {waiting.length > 0 && blocked.length > 0 && (
            <p>
              Не принято сервером: {blocked.length}. Нужно ваше решение: «Отправить снова» или «Удалить с телефона».
            </p>
          )}
          {waiting.length > 0 && !state.sending && !state.needsLogin && state.triedAt && (
            <p className="queue-tried">Последняя попытка: {phoneTime(state.triedAt)}.</p>
          )}
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
            {blocked.length === 0 && (
              <button type="button" className="secondary small" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "Скрыть список" : "Показать список"}
              </button>
            )}
          </div>

          {(open || blocked.length > 0) && (
            <ul className="queue-list">
              {mine.map((entry) => (
                <Row key={entry.id} entry={entry} categories={categories} removing={removing} onRemoving={setRemoving} />
              ))}
            </ul>
          )}

          {waiting.length > 0 && <p className="queue-hint">Ошиблись в сумме? Когда запись уйдёт, исправьте её в «Журнале».</p>}
          <p className="queue-hint">Не удаляйте приложение, пока есть неотправленные записи: вместе с ним удалятся и они.</p>
        </>
      )}

      {others.length > 0 && (
        <>
          <p className="queue-others">
            На этом телефоне есть записи другого {otherLogins.length === 1 ? "кассира" : "кассиров"} ({otherLogins.join(", ")}): {others.length}.{" "}
            Они уйдут после {otherLogins.length === 1 ? "его" : "их"} входа.
          </p>
          <div className="queue-actions">
            <button type="button" className="secondary small" aria-expanded={openOthers} onClick={() => setOpenOthers(!openOthers)}>
              {openOthers ? "Скрыть записи" : "Показать записи"}
            </button>
          </div>
          {openOthers && (
            <>
              <ul className="queue-list">
                {others.map((entry) => (
                  <Row key={entry.id} entry={entry} categories={categories} removing={removing} onRemoving={setRemoving} theirs />
                ))}
              </ul>
              <p className="queue-hint">
                Если {otherLogins.length === 1 ? "он больше не работает" : "они больше не работают"} и войти не смогут, записи можно удалить: деньги по ним нигде не учтены.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

type RowProps = {
  entry: QueuedEntry;
  categories: Category[];
  removing: string | null;
  onRemoving: (id: string | null) => void;
  /** An entry of another cashier: it can be looked at and given up, not sent from here. */
  theirs?: boolean;
};

function Row({ entry, categories, removing, onRemoving, theirs = false }: RowProps) {
  const blocked = entry.status === "blocked";
  const mayDecide = blocked || theirs;
  const input = entry.input;
  const extra = [
    input.type === "expense" && input.clientCode ? `клиент ${input.clientCode}` : "",
    input.type === "expense" && input.recipient && input.clientCode ? input.recipient : "",
    input.comment ?? "",
  ].filter(Boolean);

  return (
    <li className={blocked ? "queue-entry blocked" : "queue-entry"}>
      <span className="queue-entry-text">
        <span className="when">{phoneTime(entry.queuedAt)}</span> {theirs ? `${entry.login}: ` : ""}
        {entryText(input, categories)}
      </span>
      {extra.length > 0 && <span className="queue-comment">{extra.join(" · ")}</span>}
      {theirs && blocked && <span className="queue-problem">Сервер не принял эту запись.</span>}
      {!theirs && entry.problem && <span className="queue-problem">{problemText(entry.problem)}</span>}
      {mayDecide && (
        <span className="queue-entry-actions">
          {removing === entry.id ? (
            <>
              <span className="queue-warning" tabIndex={-1} ref={(node) => node?.focus()}>
                Удалить эту запись с телефона? На сервере её нет, в журнал и остаток она не попадёт, владелец её не увидит.
                Если деньги выданы или получены, внесите запись заново.
              </span>
              <button
                key="really"
                type="button"
                className="danger small"
                onClick={() => {
                  onRemoving(null);
                  void queue.discard(entry.id);
                }}
              >
                Да, удалить
              </button>
              <button key="no" type="button" className="secondary small" onClick={() => onRemoving(null)}>
                Отмена
              </button>
            </>
          ) : (
            <>
              {blocked && !theirs && (
                <button key="again" type="button" className="small" onClick={() => void queue.retry(entry.id)}>
                  Отправить снова
                </button>
              )}
              <button key="ask" type="button" className="secondary small" onClick={() => onRemoving(entry.id)}>
                Удалить с телефона
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
