import { useEffect, useState, type MutableRefObject } from "react";
import type { Balance, Operation, OperationInput } from "./api";
import { formatMoney } from "./money";
import { submitEntry } from "./queue-instance";

const SERVER_MAY_HAVE_SAVED =
  "Сервер сейчас не справился. Возможно, запись уже сохранилась. Нажмите кнопку ещё раз: дубля не будет.";

/** What the form says when the entry is on the phone and has not reached the server yet. */
const KEPT_ON_THE_PHONE = {
  offline: "Нет связи. Запись сохранена на телефоне и отправится сама, когда связь появится.",
  server: "Сервер сейчас не отвечает как надо. Запись сохранена на телефоне и отправится сама.",
  login: "Нужно войти заново. Запись сохранена на телефоне и отправится после входа.",
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
};

/**
 * What every entry form shares: the id is kept while the entry is retried and renewed
 * once it is saved; a busy flag against double taps; Russian error messages.
 */
export function useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed }: Options) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Operation | null>(null);
  // Set when the last entry is on the phone and not yet on the server.
  const [note, setNote] = useState<string | null>(null);

  // A correction shows in the banner; a deletion takes the banner away.
  useEffect(() => {
    if (!changed) return;
    setSaved((current) => (current && current.id === changed.id ? (changed.deletedAt ? null : changed) : current));
  }, [changed]);

  /**
   * Writes the entry to the phone and sends it. Resolves true when the entry is safe, on the
   * server or on the phone waiting for a connection, so the form can clear itself.
   */
  async function send(build: (id: string) => OperationInput): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await submitEntry(build(entryId.current));

      if (outcome.kind === "saved") {
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
        entryId.current = crypto.randomUUID();
        setSaved(null);
        setNote(KEPT_ON_THE_PHONE[outcome.why]);
        if (outcome.why === "login") onSessionExpired();
        return true;
      }

      if (outcome.kind === "not-kept") {
        // Neither the server nor the phone has it: only this form does, with the same id for the next try.
        if (outcome.why === "login") {
          onSessionExpired();
          return false;
        }
        setError(
          outcome.why === "offline"
            ? "Нет связи с сервером, и запись не удалось сохранить на телефоне. Нажмите кнопку ещё раз, когда появится интернет: дубля не будет."
            : SERVER_MAY_HAVE_SAVED,
        );
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
