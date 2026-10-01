import { useEffect, useRef, useState } from "react";
import { fetchDefaultCurrency, type Balance, type Operation } from "./api";
import { ExpenseForm } from "./ExpenseForm";
import { IncomeForm } from "./IncomeForm";
import { Journal } from "./Journal";
import type { Currency } from "./money";
import { rememberedCurrency } from "./remembered-currency";

type Props = {
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

type Form = "income" | "expense";

/** The cashier's working screen: income, expense (sharing the currency choice) and their journal. */
export function EntryScreen({ onSaved, onBalancesStale, onSessionExpired }: Props) {
  // Both forms stay alive, only hidden, while the other form or the journal is open: a cashier who
  // peeks at the journal, or at the other form, in the middle of an entry must find their typing where
  // they left it (an expense that the server refused for lack of money is exactly when they go and enter
  // the income first).
  const [form, setForm] = useState<Form>("income");
  const [journalOpen, setJournalOpen] = useState(false);
  // What the cashier last corrected or deleted in the journal, for the "saved" banners.
  const [changed, setChanged] = useState<Operation | null>(null);
  // The currency of the last entry is known without the server: a form opened offline starts with it.
  const [currency, setCurrency] = useState<Currency>(() => rememberedCurrency() ?? "RUB");
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
    changed,
  };

  return (
    <>
      <div className="tabs" role="group" aria-label="Раздел">
        <button
          type="button"
          className={!journalOpen && form === "income" ? "tab active" : "tab"}
          aria-pressed={!journalOpen && form === "income"}
          onClick={() => {
            setForm("income");
            setJournalOpen(false);
          }}
        >
          Приход
        </button>
        <button
          type="button"
          className={!journalOpen && form === "expense" ? "tab active" : "tab"}
          aria-pressed={!journalOpen && form === "expense"}
          onClick={() => {
            setForm("expense");
            setJournalOpen(false);
          }}
        >
          Расход
        </button>
        <button
          type="button"
          className={journalOpen ? "tab active" : "tab"}
          aria-pressed={journalOpen}
          onClick={() => setJournalOpen(true)}
        >
          Журнал
        </button>
      </div>

      <div hidden={journalOpen || form !== "income"}>
        <IncomeForm {...shared} active={!journalOpen && form === "income"} />
      </div>
      <div hidden={journalOpen || form !== "expense"}>
        <ExpenseForm {...shared} active={!journalOpen && form === "expense"} />
      </div>
      {journalOpen && (
        <Journal
          mode="cashier"
          onSessionExpired={onSessionExpired}
          onRefresh={onBalancesStale}
          onBalances={onSaved}
          onOperationChanged={setChanged}
        />
      )}
    </>
  );
}
