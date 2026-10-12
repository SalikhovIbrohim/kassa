import { useEffect, useRef, useState } from "react";
import { fetchDefaultCurrency, type Balance, type Operation } from "./api";
import { ExpenseForm } from "./ExpenseForm";
import { IncomeForm } from "./IncomeForm";
import { Journal } from "./Journal";
import type { Currency } from "./money";
import { rememberedCurrency } from "./remembered-currency";
import { ReconcileBar } from "./ReconcileBar";
import { useCategories } from "./useCategories";

type Props = {
  /** The cashier signed in. */
  login: string;
  /** An admin is a cashier who also counts the cash against the book. */
  admin: boolean;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

type Form = "income" | "expense";

/** The cashier's working screen: income, expense (sharing the currency choice) and their journal. */
export function EntryScreen({ login, admin, onSaved, onBalancesStale, onSessionExpired }: Props) {
  const { list: categories, reload: reloadCategories } = useCategories(onSessionExpired);
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
  // Set when the cashier picks a currency or types anything: from then on the server's idea of it is not to
  // change what they see, or an amount typed as dollars would be booked as rubles.
  const currencyTouched = useRef(false);
  const entryId = useRef(crypto.randomUUID());

  useEffect(() => {
    // The phone remembers the last entry made on it, also one that has not reached the server yet, which the
    // server cannot know about: that wins. The server's idea is for a phone that remembers nothing.
    if (rememberedCurrency() !== null) return;
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
    categories,
    onReloadCategories: reloadCategories,
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

      {/* Counting the cash is not done with every entry, so it lives with the journal and takes no room on the forms.
          It stays mounted while hidden: a count typed in survives a look at another tab. */}
      {admin && (
        <div hidden={!journalOpen}>
          <ReconcileBar login={login} onBalances={onSaved} onSessionExpired={onSessionExpired} />
        </div>
      )}

      <div hidden={journalOpen || form !== "income"} onInputCapture={() => (currencyTouched.current = true)}>
        <IncomeForm {...shared} active={!journalOpen && form === "income"} />
      </div>
      <div hidden={journalOpen || form !== "expense"} onInputCapture={() => (currencyTouched.current = true)}>
        <ExpenseForm {...shared} active={!journalOpen && form === "expense"} />
      </div>
      {journalOpen && (
        <Journal
          mode="cashier"
          login={login}
          onSessionExpired={onSessionExpired}
          onRefresh={onBalancesStale}
          onBalances={onSaved}
          onOperationChanged={setChanged}
        />
      )}
    </>
  );
}
