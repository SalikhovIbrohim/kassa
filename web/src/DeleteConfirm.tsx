import { useState, type FormEvent } from "react";
import { deleteOperation, NetworkError, type Balance, type Operation } from "./api";
import { explainFailure, NO_CONNECTION } from "./changeMessages";
import { usePanelEntrance } from "./usePanelEntrance";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  operation: Operation;
  /** What the operation is, in words, for the question: "Приход +1 500,00 ₽". */
  description: string;
  onDeleted: (operation: Operation, balances: Balance[]) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
  /** The operation no longer exists as it was (deleted elsewhere): say so and refresh the journal. */
  onGone: (message: string) => void;
};

/** Asks once before deleting, and takes an optional reason. The record is hidden, never destroyed. */
export function DeleteConfirm({ operation, description, onDeleted, onCancel, onSessionExpired, onGone }: Props) {
  const { root, heading } = usePanelEntrance<HTMLFormElement>();
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
      if (result.reason === "deleted" || result.reason === "not-found") {
        onGone(`${explainFailure(result)} Журнал обновлён.`);
        return;
      }
      setError(explainFailure(result));
    } catch (caught) {
      setError(caught instanceof NetworkError ? NO_CONNECTION : "Не получилось удалить. Попробуйте ещё раз.");
    }
    setBusy(false);
  }

  return (
    <form className="panel-body" onSubmit={submit} aria-label="Удалить запись" ref={root}>
      <h3 ref={heading} tabIndex={-1}>
        Удалить запись?
      </h3>
      <p>
        Запись «{description}» исчезнет из журнала и из остатка, но останется в истории: смотрящий увидит, что её
        удалили, кто и когда.
      </p>

      <Label>
        <span>
          Причина <span className="optional">(необязательно)</span>
        </span>
        <Input
          name="reason"
          type="text"
          autoComplete="off"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Label>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}

      <div className="panel-buttons">
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Удаляем…" : "Удалить"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
