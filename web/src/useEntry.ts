import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Balance, Category, Operation, OperationInput } from "./api";
import { formatMoney } from "./money";
import { onQueuedEntrySaved, submitEntry, useQueueState } from "./queue-instance";
import { entryText } from "./queue-text";
import { rememberCurrency } from "./remembered-currency";

const SERVER_MAY_HAVE_SAVED =
  "Сервер сейчас не справился. Возможно, запись уже сохранилась. Нажмите кнопку ещё раз: дубля не будет.";

/** Why an entry is on the phone and not on the server, and what happens next. */
const WHY_KEPT = {
  offline: "Уйдёт, когда появится связь и приложение будет открыто.",
  server: "Сервер не ответил как надо. Отправим ещё раз сами, пока приложение открыто.",
  slow: "Сервер отвечает долго. Отправка идёт: держите приложение открытым.",
  login: "Нужно войти заново: запись уйдёт после входа.",
} as const;

type Options = {
  /**
   * The id of the entry being made. It is owned by the screen, not by one form, so it
   * survives switching between the income and expense tabs: an entry that failed for
   * lack of connection may have reached the server, and must not be counted twice.
   */
  entryId: MutableRefObject<string>;
  onSaved: (balances: Balance[]) => void;
  /** The screen may show out-of-date balances (e.g. a saved entry whose answer was lost). */
  onBalancesStale: () => void;
  onSessionExpired: () => void;
  /**
   * The operation the cashier last corrected or deleted in the journal. If it is the one the
   * "saved" banner is about, the banner must not keep saying what it said before.
   */
  changed?: Operation | null;
  /** Names of the categories, for the line that says what was kept on the phone. */
  categories?: readonly Category[];
};

/** What the form says about its last entry while it is on the phone and not yet on the server. */
export type EntryNote = { kind: "kept" | "blocked"; text: string };

/**
 * What every entry form shares: the id is kept while the entry is retried and renewed
 * once it is saved; a busy flag against double taps; Russian error messages.
 */
export function useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed, categories }: Options) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Operation | null>(null);
  // The last entry, while it is on the phone and not yet on the server: what it was, and what was said.
  const [kept, setKept] = useState<{ id: string; echo: string; text: string } | null>(null);
  const keptId = useRef<string | null>(null);
  const queued = useQueueState().entries;

  // A correction shows in the banner; a deletion takes the banner away.
  useEffect(() => {
    if (!changed) return;
    setSaved((current) => (current && current.id === changed.id ? (changed.deletedAt ? null : changed) : current));
  }, [changed]);

  // The entry that was kept on the phone has reached the server by itself: it says so, like any saved entry.
  useEffect(
    () =>
      onQueuedEntrySaved((_balances, operation) => {
        if (operation.id !== keptId.current) return;
        keptId.current = null;
        setKept(null);
        if (operation.deletedAt === null) setSaved(operation);
      }),
    [],
  );

  const onThePhone = kept ? queued.find((entry) => entry.id === kept.id) : undefined;
  // Gone from the phone without having been saved: the cashier gave it up. Nothing more to say about it.
  useEffect(() => {
    if (kept && !onThePhone) {
      keptId.current = null;
      setKept(null);
    }
  }, [kept, onThePhone]);

  const note: EntryNote | null =
    kept && onThePhone
      ? onThePhone.status === "blocked"
        ? {
            kind: "blocked",
            text: `Сервер не принял запись: ${kept.echo}. Что с ней делать, решите в плашке «Не отправлено» ниже.`,
          }
        : { kind: "kept", text: kept.text }
      : null;

  /**
   * Writes the entry to the phone and sends it. Resolves true when the entry is safe, on the
   * server or on the phone waiting for a connection, so the form can clear itself.
   */
  async function send(build: (id: string) => OperationInput): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    keptId.current = null;
    setKept(null);
    try {
      const input = build(entryId.current);
      const outcome = await submitEntry(input);

      if (outcome.kind === "saved") {
        rememberCurrency(input.currency);
        entryId.current = crypto.randomUUID();
        onSaved(outcome.balances);
        if (outcome.operation.deletedAt !== null) {
          // The entry had reached the server before and was deleted since: nothing was written
          // now. Say so, keep what was typed, and let the next press write it as a new entry.
          setError("Эта запись уже была сохранена и потом удалена. Нажмите кнопку ещё раз, чтобы записать её заново.");
          return false;
        }
        setSaved(outcome.operation);
        return true;
      }

      if (outcome.kind === "kept") {
        // It is on the phone under its own id; the next entry is a new one.
        rememberCurrency(input.currency);
        entryId.current = crypto.randomUUID();
        setSaved(null);
        const echo = entryText(input, categories ?? []);
        keptId.current = input.id;
        setKept({
          id: input.id,
          echo,
          text: `Сохранено на телефоне, на сервер не ушло: ${echo}. ${WHY_KEPT[outcome.why]}`,
        });
        if (outcome.why === "login") onSessionExpired();
        return true;
      }

      if (outcome.kind === "not-kept") {
        // Neither the server nor the phone has it: only this form does, with the same id for the next try.
        if (outcome.why === "login") {
          // The session has ended and the phone cannot keep the entry. The screen must not go away with the only
          // copy of what was typed: it stays, and says what to do.
          setError(
            `Нужно войти заново, а на телефоне запись сохранить не удалось: ${entryText(input, categories ?? [])}. ` +
              "Нажмите «Выйти», войдите снова и внесите её.",
          );
          return false;
        }
        setError(
          outcome.why === "offline"
            ? "Нет связи с сервером, и запись не удалось сохранить на телефоне. Нажмите кнопку ещё раз, когда появится интернет: дубля не будет."
            : SERVER_MAY_HAVE_SAVED,
        );
        return false;
      }

      if (outcome.kind === "busy") {
        // The id is the one of an entry made in the other form a moment ago, still on its way: nothing was taken
        // and nothing was replaced. This form gets an id of its own, and what is typed stays for the next press.
        entryId.current = crypto.randomUUID();
        setError("Предыдущая запись ещё отправляется. Подождите секунду и нажмите кнопку ещё раз.");
        return false;
      }

      const problem = outcome.problem;
      if (problem.kind === "conflict") {
        // This id is taken by an entry that was saved before. Whatever is typed now is
        // a new entry, so it must not keep colliding with the old one.
        entryId.current = crypto.randomUUID();
        // The earlier entry is on the server but the screen may not know it yet.
        onBalancesStale();
      }
      if (problem.kind === "insufficient-balance") {
        // The screen may have shown more money than there is: bring it up to date.
        onBalancesStale();
        setError(
          `В кассе не хватает денег: сейчас ${formatMoney(problem.availableMinor, problem.currency)}. ` +
            "Проверьте сумму. Если деньги уже выданы, сначала внесите недостающий приход.",
        );
        return false;
      }
      setError(
        {
          forbidden: "У вас нет права вносить операции.",
          conflict: "Эта запись уже сохранена раньше, возможно с другой суммой. Проверьте остаток.",
          rejected: "Проверьте данные и попробуйте ещё раз.",
        }[problem.kind],
      );
      return false;
    } catch {
      setError("Не получилось записать. Попробуйте ещё раз.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, saved, note, send };
}
