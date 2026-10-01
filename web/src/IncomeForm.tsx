import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import type { Balance, Operation } from "./api";
import { ClientCodeField } from "./ClientCodeField";
import { CurrencyPicker } from "./CurrencyPicker";
import { EntryStatus } from "./EntryStatus";
import { AmountInput } from "./AmountInput";
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
  /** The form is on the screen (and not hidden behind the other one or the journal). */
  active: boolean;
};

export function IncomeForm({
  entryId,
  currency,
  onCurrencyChange,
  onSaved,
  onBalancesStale,
  onSessionExpired,
  changed,
  active,
}: Props) {
  const [amount, setAmount] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed });

  // The cursor is in the amount whenever this form comes to the front (it is kept alive when it is hidden).
  useEffect(() => {
    if (active) amountInput.current?.focus();
  }, [active]);

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
      <h2 className="sr-only">Приход</h2>

      <EntryStatus note={entry.note}>
        {entry.saved?.type === "income" && (
          <p className="success">
            Записано: приход {formatMoney(entry.saved.amountMinor, entry.saved.currency)}, клиент{" "}
            {entry.saved.clientCode}. <span className="when">{formatMoscowTime(entry.saved.createdAt)} (МСК)</span>
          </p>
        )}
      </EntryStatus>

      <CurrencyPicker value={currency} onChange={onCurrencyChange} />

      <label>
        Сумма
        <AmountInput
          ref={amountInput}
          name="amount"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="0"
          required
          value={amount}
          onChange={setAmount}
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
