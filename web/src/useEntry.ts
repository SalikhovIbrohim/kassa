import { useState, type MutableRefObject } from "react";
import {
  createOperation,
  NetworkError,
  type Balance,
  type Operation,
  type OperationInput,
} from "./api";

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
};

/**
 * What every entry form shares: the id is kept while the entry is retried and renewed
 * once it is saved; a busy flag against double taps; Russian error messages.
 */
export function useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired }: Options) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Operation | null>(null);

  /** Sends the entry. Resolves true when it was saved, so the form can clear itself. */
  async function send(build: (id: string) => OperationInput): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await createOperation(build(entryId.current));

      if (result.ok) {
        entryId.current = crypto.randomUUID();
        setSaved(result.operation);
        onSaved(result.balances);
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
