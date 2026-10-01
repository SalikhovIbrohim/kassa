import { useState, type FormEvent } from "react";
import { deleteOperation, NetworkError, type Balance, type Operation } from "./api";
import { explainFailure, NO_CONNECTION } from "./changeMessages";

type Props = {
  operation: Operation;
  /** What the operation is, in words, for the question: "Приход +1 500,00 ₽". */
  description: string;
  onDeleted: (operation: Operation, balances: Balance[]) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
};

/** Asks once before deleting, and takes an optional reason. The record is hidden, never destroyed. */
export function DeleteConfirm({ operation, description, onDeleted, onCancel, onSessionExpired }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteOperation(operation.id, reason.trim() || undefined);
      if (result.ok) {
        onDeleted(result.operation, result.balances);
        return;
      }
      if (result.reason === "session-expired") {
        onSessionExpired();
        return;
      }
      setError(explainFailure(result, "delete"));
    } catch (caught) {
      setError(caught instanceof NetworkError ? NO_CONNECTION : "Не получилось удалить. Попробуйте ещё раз.");
    }
    setBusy(false);
  }

  return (
    <form className="panel-body" onSubmit={submit} aria-label="Удалить запись">
      <h3>Удалить запись?</h3>
      <p>
        Запись «{description}» исчезнет из журнала и из остатка, но останется в истории: смотрящий увидит, что её
        удалили, кто и когда.
      </p>

      <label>
        <span>
          Причина <span className="optional">(необязательно)</span>
        </span>
        <input
          name="reason"
          type="text"
          autoComplete="off"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="panel-buttons">
        <button type="submit" className="danger" disabled={busy}>
          {busy ? "Удаляем…" : "Удалить"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
