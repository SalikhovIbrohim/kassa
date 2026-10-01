import { useRef, useState, type FormEvent } from "react";
import {
  editOperation,
  NetworkError,
  REFUND_CATEGORY,
  type Balance,
  type Category,
  type EditInput,
  type Operation,
} from "./api";
import { CategoryPicker } from "./CategoryPicker";
import { ClientCodeField } from "./ClientCodeField";
import { explainFailure, NO_CONNECTION } from "./changeMessages";
import { CurrencyPicker } from "./CurrencyPicker";
import { AmountInput } from "./AmountInput";
import { formatAmountInput, parseAmountInput, type Currency } from "./money";
import { usePanelEntrance } from "./usePanelEntrance";

type Props = {
  operation: Operation;
  categories: Category[];
  onSaved: (operation: Operation, balances: Balance[]) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
  /** The operation no longer exists as it was (deleted elsewhere): say so and refresh the journal. */
  onGone: (message: string) => void;
  /** The list of categories did not load: ask for it again. */
  onReloadCategories: () => void;
};

/**
 * Corrects one operation: the same fields as when it was written (the type never changes),
 * starting from what it says now, and an optional reason.
 */
export function OperationEditor({
  operation,
  categories,
  onSaved,
  onCancel,
  onSessionExpired,
  onGone,
  onReloadCategories,
}: Props) {
  const isIncome = operation.type === "income";
  const [currency, setCurrency] = useState<Currency>(operation.currency);
  const [amount, setAmount] = useState(formatAmountInput(operation.amountMinor));
  const [category, setCategory] = useState<string | null>(operation.category);
  const [clientCode, setClientCode] = useState(operation.clientCode ?? "");
  const [recipient, setRecipient] = useState(operation.recipient ?? "");
  const [comment, setComment] = useState(operation.comment ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const { root, heading } = usePanelEntrance<HTMLFormElement>();

  const isRefund = category === REFUND_CATEGORY;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const amountMinor = parseAmountInput(amount);
    if (amountMinor === null) {
      setError("Введите сумму больше нуля, например 1500 или 1500,50.");
      amountInput.current?.focus();
      return;
    }
    if (!isIncome && category === null) {
      setError("Выберите, на что ушли деньги.");
      return;
    }
    const code = clientCode.trim();
    if ((isIncome || isRefund) && code === "") {
      setError(isIncome ? "Введите код клиента." : "Для возврата клиенту введите код клиента.");
      return;
    }

    const common = {
      amountMinor,
      currency,
      comment: comment.trim() || undefined,
      reason: reason.trim() || undefined,
    };
    const input: EditInput = isIncome
      ? { type: "income", clientCode: code, ...common }
      : {
          type: "expense",
          category: category!,
          recipient: recipient.trim() || undefined,
          clientCode: isRefund ? code : undefined,
          ...common,
        };

    setBusy(true);
    setError(null);
    try {
      const result = await editOperation(operation.id, input);
      if (result.ok) {
        onSaved(result.operation, result.balances);
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
      setError(caught instanceof NetworkError ? NO_CONNECTION : "Не получилось сохранить. Попробуйте ещё раз.");
    }
    setBusy(false);
  }

  return (
    <form className="panel-body" onSubmit={submit} aria-label="Изменить запись" ref={root}>
      <h3 ref={heading} tabIndex={-1}>
        Изменить запись
      </h3>

      <CurrencyPicker value={currency} onChange={setCurrency} />

      <label>
        Сумма
        <AmountInput
          ref={amountInput}
          name="amount"
          autoComplete="off"
          required
          value={amount}
          onChange={setAmount}
        />
      </label>

      {!isIncome &&
        (categories.length > 0 ? (
          <CategoryPicker categories={categories} value={category} onChange={setCategory} />
        ) : (
          <div className="categories-missing">
            <p className="error" role="alert">
              Список категорий не загрузился.
            </p>
            <button type="button" className="secondary" onClick={onReloadCategories}>
              Повторить
            </button>
          </div>
        ))}

      {(isIncome || isRefund) && <ClientCodeField value={clientCode} onChange={setClientCode} />}

      {!isIncome && (
        <label>
          <span>
            Кому выдали <span className="optional">(необязательно)</span>
          </span>
          <input
            name="recipient"
            type="text"
            autoComplete="off"
            maxLength={100}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
      )}

      <label>
        <span>
          Комментарий <span className="optional">(необязательно)</span>
        </span>
        <input
          name="comment"
          type="text"
          autoComplete="off"
          maxLength={500}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <label>
        <span>
          Причина правки <span className="optional">(необязательно, видит смотрящий)</span>
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
        <button type="submit" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
