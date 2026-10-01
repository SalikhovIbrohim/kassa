import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { fetchCategories, REFUND_CATEGORY, SessionExpiredError, type Balance, type Category } from "./api";
import { CategoryPicker } from "./CategoryPicker";
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
};

export function ExpenseForm({
  entryId,
  currency,
  onCurrencyChange,
  onSaved,
  onBalancesStale,
  onSessionExpired,
}: Props) {
  // null: loading, undefined: failed to load.
  const [categories, setCategories] = useState<Category[] | null | undefined>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [recipient, setRecipient] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired });

  function loadCategories() {
    setCategories(null);
    fetchCategories().then(setCategories, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setCategories(undefined);
    });
  }
  useEffect(loadCategories, []);

  const isRefund = category === REFUND_CATEGORY;

  async function submit(event: FormEvent) {
    event.preventDefault();

    const amountMinor = parseAmountInput(amount);
    if (amountMinor === null) {
      entry.setError("Введите сумму больше нуля, например 1500 или 1500,50.");
      return;
    }
    if (category === null) {
      entry.setError("Выберите, на что ушли деньги.");
      return;
    }
    const code = clientCode.trim();
    if (isRefund && code === "") {
      entry.setError("Для возврата клиенту введите код клиента.");
      return;
    }

    const saved = await entry.send((id) => ({
      type: "expense",
      id,
      amountMinor,
      currency,
      category,
      recipient: recipient.trim() || undefined,
      clientCode: isRefund ? code : undefined,
      comment: comment.trim() || undefined,
    }));
    if (saved) {
      setAmount("");
      setClientCode("");
      setRecipient("");
      setComment("");
      setCategory(null);
      amountInput.current?.focus();
    }
  }

  const savedLabel = categories?.find((item) => item.code === entry.saved?.category)?.label;

  return (
    <form className="card" onSubmit={submit}>
      <h2>Расход</h2>

      {entry.saved?.type === "expense" && (
        <p className="success" role="status">
          Записано: {savedLabel ?? "расход"}, {formatMoney(entry.saved.amountMinor, entry.saved.currency)}.{" "}
          <span className="when">{formatMoscowTime(entry.saved.createdAt)} (МСК)</span>
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

      {categories ? (
        <CategoryPicker categories={categories} value={category} onChange={setCategory} />
      ) : (
        <fieldset className="choices categories">
          <legend>На что ушли деньги</legend>
          {categories === null && <p className="hint">Загрузка…</p>}
          {categories === undefined && (
            <div>
              <p className="error" role="alert">
                Не удалось загрузить список.
              </p>
              <button type="button" className="secondary" onClick={loadCategories}>
                Повторить
              </button>
            </div>
          )}
        </fieldset>
      )}

      {isRefund && <ClientCodeField value={clientCode} onChange={setClientCode} />}

      <label>
        <span>
          Кому выдали <span className="optional">(необязательно)</span>
        </span>
        <input
          name="recipient"
          type="text"
          autoComplete="off"
          enterKeyHint="next"
          maxLength={100}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
        />
      </label>

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
        {entry.busy ? "Записываем…" : "Записать расход"}
      </button>
    </form>
  );
}
