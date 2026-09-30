import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createIncome,
  fetchClientCodes,
  fetchDefaultCurrency,
  NetworkError,
  type Balance,
  type Operation,
} from "./api";
import {
  CURRENCIES,
  CURRENCY_NAME,
  formatMoney,
  formatMoscowTime,
  parseAmountInput,
  type Currency,
} from "./money";

type Props = {
  onSaved: (balances: Balance[]) => void;
  onSessionExpired: () => void;
};

export function IncomeForm({ onSaved, onSessionExpired }: Props) {
  const [currency, setCurrency] = useState<Currency>("RUB");
  const [amount, setAmount] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [comment, setComment] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Operation | null>(null);

  const amountInput = useRef<HTMLInputElement>(null);
  // One id per entry, kept while the entry is retried, renewed after it is saved.
  const entryId = useRef(crypto.randomUUID());
  const currencyTouched = useRef(false);

  useEffect(() => {
    fetchDefaultCurrency().then(
      (last) => {
        if (!currencyTouched.current) setCurrency(last);
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchClientCodes(clientCode.trim()).then(setSuggestions);
    }, 150);
    return () => clearTimeout(timer);
  }, [clientCode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const amountMinor = parseAmountInput(amount);
    if (amountMinor === null) {
      setError("Введите сумму больше нуля, например 1500 или 1500,50.");
      return;
    }
    const code = clientCode.trim();
    if (code === "") {
      setError("Введите код клиента.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await createIncome({
        id: entryId.current,
        amountMinor,
        currency,
        clientCode: code,
        comment: comment.trim() || undefined,
      });

      if (result.ok) {
        entryId.current = crypto.randomUUID();
        setSaved(result.operation);
        setAmount("");
        setClientCode("");
        setComment("");
        onSaved(result.balances);
        amountInput.current?.focus();
        return;
      }

      if (result.reason === "session-expired") {
        onSessionExpired();
        return;
      }
      if (result.reason === "conflict") {
        // This id is taken by an entry that was saved before. Whatever is typed now is
        // a new entry, so it must not keep colliding with the old one.
        entryId.current = crypto.randomUUID();
      }
      setError(
        {
          forbidden: "У вас нет права вносить операции.",
          conflict:
            "Этот приход уже записан раньше, возможно с другой суммой. Проверьте остаток.",
          rejected: "Проверьте данные и попробуйте ещё раз.",
        }[result.reason],
      );
    } catch (caught) {
      setError(
        caught instanceof NetworkError
          ? "Нет связи. Приход не записан. Нажмите «Записать» ещё раз, когда появится интернет."
          : "Не получилось записать. Попробуйте ещё раз.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Приход</h2>

      {saved && (
        <p className="success" role="status">
          Записано: {formatMoney(saved.amountMinor, saved.currency)}, клиент {saved.clientCode}.{" "}
          <span className="when">{formatMoscowTime(saved.createdAt)} (МСК)</span>
        </p>
      )}

      <fieldset className="currency">
        <legend>Валюта</legend>
        {CURRENCIES.map((code) => (
          <label key={code} className={code === currency ? "choice chosen" : "choice"}>
            <input
              type="radio"
              name="currency"
              value={code}
              checked={code === currency}
              onChange={() => {
                currencyTouched.current = true;
                setCurrency(code);
              }}
            />
            {CURRENCY_NAME[code]}
          </label>
        ))}
      </fieldset>

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

      <label>
        Код клиента
        <input
          name="clientCode"
          type="text"
          list="client-codes"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          required
          maxLength={64}
          value={clientCode}
          onChange={(event) => setClientCode(event.target.value)}
        />
        <datalist id="client-codes">
          {suggestions.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
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

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Записываем…" : "Записать приход"}
      </button>
    </form>
  );
}
