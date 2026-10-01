import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import {
  fetchCategories,
  REFUND_CATEGORY,
  SessionExpiredError,
  type Balance,
  type Category,
  type Operation,
} from "./api";
import { CategoryPicker } from "./CategoryPicker";
import { ClientCodeField } from "./ClientCodeField";
import { CurrencyPicker } from "./CurrencyPicker";
import { EntryStatus } from "./EntryStatus";
import { AmountInput } from "./AmountInput";
import { formatMoney, formatMoscowTime, parseAmountInput, parseRateInput, type Currency } from "./money";
import { RateField } from "./RateField";
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

export function ExpenseForm({
  entryId,
  currency,
  onCurrencyChange,
  onSaved,
  onBalancesStale,
  onSessionExpired,
  changed,
  active,
}: Props) {
  // null: loading, undefined: failed to load.
  const [categories, setCategories] = useState<Category[] | null | undefined>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  // Empty to start with, and again after each entry: an expense without a rate is counted at the average of its shift.
  const [rate, setRate] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [recipient, setRecipient] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed, categories: categories ?? undefined });

  // The cursor is in the amount whenever this form comes to the front (it is kept alive when it is hidden).
  useEffect(() => {
    if (active) amountInput.current?.focus();
  }, [active]);

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
    // The rate of an expense is optional: left empty, the average of the shift is used when it is closed.
    const rateE4 = currency === "RUB" && rate.trim() !== "" ? parseRateInput(rate) : null;
    if (currency === "RUB" && rate.trim() !== "" && rateE4 === null) {
      entry.setError("Курс введён неверно: сколько рублей за 1 доллар, например 79 или 78,5. Или оставьте поле пустым.");
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
      ...(rateE4 === null ? {} : { rateE4 }),
      category,
      recipient: recipient.trim() || undefined,
      clientCode: isRefund ? code : undefined,
      comment: comment.trim() || undefined,
    }));
    if (saved) {
      setAmount("");
      setRate("");
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
      <h2 className="sr-only">Расход</h2>

      <EntryStatus note={entry.note}>
        {entry.saved?.type === "expense" && (
          <p className="success">
            Записано: {savedLabel ?? "расход"}, {formatMoney(entry.saved.amountMinor, entry.saved.currency)}.{" "}
            <span className="when">{formatMoscowTime(entry.saved.createdAt)} (МСК)</span>
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

      {currency === "RUB" && <RateField value={rate} onChange={setRate} required={false} />}

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
