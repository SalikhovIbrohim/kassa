import { useEffect, useState, type MutableRefObject } from "react";
import {
  createOperation,
  NetworkError,
  type Balance,
  type Operation,
  type OperationInput,
} from "./api";
import { formatMoney } from "./money";

const SERVER_MAY_HAVE_SAVED =
  "Сервер сейчас не справился. Возможно, запись уже сохранилась. Нажмите кнопку ещё раз: дубля не будет.";

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

  // A correction shows in the banner; a deletion takes the banner away.
  useEffect(() => {
    if (!changed) return;
    setSaved((current) => (current && current.id === changed.id ? (changed.deletedAt ? null : changed) : current));
  }, [changed]);

  /** Sends the entry. Resolves true when it was saved, so the form can clear itself. */
  async function send(build: (id: string) => OperationInput): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await createOperation(build(entryId.current));

      if (result.ok) {
        entryId.current = crypto.randomUUID();
        onSaved(result.balances);
        if (result.operation.deletedAt !== null) {
          // The entry had reached the server before and was deleted since: nothing was written
          // now. Say so, keep what was typed, and let the next press write it as a new entry.
          setError("Эта запись уже была сохранена и потом удалена. Нажмите кнопку ещё раз, чтобы записать её заново.");
          return false;
        }
        setSaved(result.operation);
        return true;
      }

      if (result.reason === "session-expired") {
        onSessionExpired();
        return false;
      }
      if (result.reason === "conflict") {
        // This id is taken by an entry that was saved before. Whatever is typed now is
        // a new entry, so it must not keep colliding with the old one.
        entryId.current = crypto.randomUUID();
        // The earlier entry is on the server but the screen may not know it yet.
        onBalancesStale();
      }
      if (result.reason === "server-error") {
        // Whether the entry was written is not known: the same id makes a retry safe.
        setError(SERVER_MAY_HAVE_SAVED);
        return false;
      }
      if (result.reason === "insufficient-balance") {
        // The screen may have shown more money than there is: bring it up to date.
        onBalancesStale();
        setError(
          `В кассе не хватает денег: сейчас ${formatMoney(result.availableMinor, result.currency)}. ` +
            "Проверьте сумму. Если деньги уже выданы, сначала внесите недостающий приход.",
        );
        return false;
      }
      setError(
        {
          forbidden: "У вас нет права вносить операции.",
          conflict: "Эта запись уже сохранена раньше, возможно с другой суммой. Проверьте остаток.",
          rejected: "Проверьте данные и попробуйте ещё раз.",
        }[result.reason],
      );
      return false;
    } catch (caught) {
      setError(
        caught instanceof NetworkError
          ? "Нет связи с сервером. Возможно, запись уже сохранилась. Нажмите кнопку ещё раз, когда появится интернет: дубля не будет."
          : "Не получилось записать. Попробуйте ещё раз.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, saved, send };
}
