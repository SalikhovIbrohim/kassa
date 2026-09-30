import { useEffect, useRef, useState } from "react";
import { fetchDefaultCurrency, type Balance } from "./api";
import { ExpenseForm } from "./ExpenseForm";
import { IncomeForm } from "./IncomeForm";
import type { Currency } from "./money";

type Props = {
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

type Mode = "income" | "expense";

/** The cashier's working screen: income or expense, sharing the currency choice. */
export function EntryScreen({ onSaved, onBalancesStale, onSessionExpired }: Props) {
  const [mode, setMode] = useState<Mode>("income");
  const [currency, setCurrency] = useState<Currency>("RUB");
  const currencyTouched = useRef(false);
  const entryId = useRef(crypto.randomUUID());

  useEffect(() => {
    fetchDefaultCurrency().then(
      (last) => {
        if (!currencyTouched.current) setCurrency(last);
      },
      () => {},
    );
  }, []);

  const shared = {
    entryId,
    currency,
    onCurrencyChange: (next: Currency) => {
      currencyTouched.current = true;
      setCurrency(next);
    },
    onSaved,
    onBalancesStale,
    onSessionExpired,
  };

  return (
    <>
      <div className="tabs" role="group" aria-label="Тип операции">
        <button
          type="button"
          className={mode === "income" ? "tab active" : "tab"}
          aria-pressed={mode === "income"}
          onClick={() => setMode("income")}
        >
          Приход
        </button>
        <button
          type="button"
          className={mode === "expense" ? "tab active" : "tab"}
          aria-pressed={mode === "expense"}
          onClick={() => setMode("expense")}
        >
          Расход
        </button>
      </div>

      {mode === "income" ? <IncomeForm {...shared} /> : <ExpenseForm {...shared} />}
    </>
  );
}
