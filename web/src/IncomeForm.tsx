import { useRef, useState, type FormEvent, type MutableRefObject } from "react";
import type { Balance, Operation } from "./api";
import { ClientCodeField } from "./ClientCodeField";
import { CurrencyPicker } from "./CurrencyPicker";
import { formatMoney, formatMoscowTime, parseAmountInput, type Currency } from "./money";
import { useEntry } from "./useEntry";

type Props = {
  entryId: MutableRefObject<string>;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
  /** The operation last corrected or deleted in the journal (see useEntry). */
  changed?: Operation | null;
};

export function IncomeForm({
  entryId,
  currency,
  onCurrencyChange,
  onSaved,
  onBalancesStale,
  onSessionExpired,
  changed,
}: Props) {
  const [amount, setAmount] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed });

  async function submit(event: FormEvent) {
    event.preventDefault();

    const amountMinor = parseAmountInput(amount);
    if (amountMinor === null) {
      entry.setError("Введите сумму больше нуля, например 1500 или 1500,50.");
      return;
    }
    const code = clientCode.trim();
    if (code === "") {
      entry.setError("Введите код клиента.");
      return;
    }

    const saved = await entry.send((id) => ({
      type: "income",
      id,
      amountMinor,
      currency,
      clientCode: code,
      comment: comment.trim() || undefined,
    }));
    if (saved) {
      setAmount("");
      setClientCode("");
      setComment("");
      amountInput.current?.focus();
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Приход</h2>

      {entry.saved?.type === "income" && (
        <p className="success" role="status">
          Записано: приход {formatMoney(entry.saved.amountMinor, entry.saved.currency)}, клиент{" "}
          {entry.saved.clientCode}. <span className="when">{formatMoscowTime(entry.saved.createdAt)} (МСК)</span>
        </p>
      )}

      <CurrencyPicker value={currency} onChange={onCurrencyChange} />

      <label>
        Сумма
        <input
          ref={amountInput}
          name="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="0"
          autoFocus
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>

      <ClientCodeField value={clientCode} onChange={setClientCode} />

      <label>
        <span>
          Комментарий <span className="optional">(необязательно)</span>
        </span>
        <input
          name="comment"
          type="text"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={500}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      {entry.error && (
        <p className="error" role="alert">
          {entry.error}
        </p>
      )}

      <button type="submit" disabled={entry.busy}>
        {entry.busy ? "Записываем…" : "Записать приход"}
      </button>
    </form>
  );
}
