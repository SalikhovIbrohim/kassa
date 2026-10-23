import { useEffect, useRef, useState } from "react";
import { fetchDefaultCurrency, type Balance, type Operation } from "./api";
import { ExpenseForm } from "./ExpenseForm";
import { IncomeForm } from "./IncomeForm";
import type { Currency } from "./money";
import { rememberedCurrency } from "./remembered-currency";
import { useCategories } from "./useCategories";
import { KASSA_CURRENCIES, useKassa } from "./kassa";

type Props = {
  /** The form shown: both stay alive, the other only hidden. */
  section: Section;
  /** What the cashier last corrected or deleted in the journal, for the "saved" banners. */
  changed: Operation | null;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

export type Section = "income" | "expense";

/** The forms of the cash desk: income and expense, sharing the currency choice. */
export function EntryScreen({ section, changed, onSaved, onBalancesStale, onSessionExpired }: Props) {
  const { list: categories, reload: reloadCategories } = useCategories(onSessionExpired);
  // Both forms stay alive, only hidden, while the other form or the journal is open: a cashier who
  // peeks at the journal, or at the other form, in the middle of an entry must find their typing where
  // they left it (an expense that the server refused for lack of money is exactly when they go and enter
  // the income first).
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

  // A cash desk keeps only its own currencies (Andijan: dollars): a currency it does not keep is not offered.
  const kept = KASSA_CURRENCIES[useKassa().kassa];
  const shared = {
    entryId,
    currency: kept.includes(currency) ? currency : kept[0]!,
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
      <div hidden={section !== "income"} onInputCapture={() => (currencyTouched.current = true)}>
        <IncomeForm {...shared} active={section === "income"} />
      </div>
      <div hidden={section !== "expense"} onInputCapture={() => (currencyTouched.current = true)}>
        <ExpenseForm {...shared} active={section === "expense"} />
      </div>
    </>
  );
}
