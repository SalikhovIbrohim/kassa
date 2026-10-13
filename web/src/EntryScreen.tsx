import { useEffect, useRef, useState } from "react";
import { fetchDefaultCurrency, type Balance, type Operation } from "./api";
import { ExpenseForm } from "./ExpenseForm";
import { IncomeForm } from "./IncomeForm";
import { Journal } from "./Journal";
import type { Currency } from "./money";
import { rememberedCurrency } from "./remembered-currency";
import { ReconcileBar } from "./ReconcileBar";
import { useCategories } from "./useCategories";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Props = {
  /** The cashier signed in. */
  login: string;
  /** An admin is a cashier who also counts the cash against the book. */
  admin: boolean;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

type Section = "income" | "expense" | "journal";

/** The cashier's working screen: income, expense (sharing the currency choice) and the journal. */
export function EntryScreen({ login, admin, onSaved, onBalancesStale, onSessionExpired }: Props) {
  const { list: categories, reload: reloadCategories } = useCategories(onSessionExpired);
  // Both forms stay alive, only hidden, while the other form or the journal is open: a cashier who
  // peeks at the journal, or at the other form, in the middle of an entry must find their typing where
  // they left it (an expense that the server refused for lack of money is exactly when they go and enter
  // the income first).
  const [section, setSection] = useState<Section>("income");
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
    <Tabs value={section} onValueChange={(next) => setSection(next as Section)}>
      <TabsList className="grid grid-cols-3">
        <TabsTrigger value="income">Приход</TabsTrigger>
        <TabsTrigger value="expense">Расход</TabsTrigger>
        <TabsTrigger value="journal">Журнал</TabsTrigger>
      </TabsList>

      <TabsContent value="income" forceMount onInputCapture={() => (currencyTouched.current = true)}>
        <IncomeForm {...shared} active={section === "income"} />
      </TabsContent>
      <TabsContent value="expense" forceMount onInputCapture={() => (currencyTouched.current = true)}>
        <ExpenseForm {...shared} active={section === "expense"} />
      </TabsContent>
      <TabsContent value="journal" forceMount className="grid gap-4">
        {/* Counting the cash is not done with every entry, so it lives with the journal and takes no room on the forms.
            It stays mounted while hidden: a count typed in survives a look at another tab. */}
        {admin && <ReconcileBar login={login} onBalances={onSaved} onSessionExpired={onSessionExpired} />}
        {section === "journal" && (
          <Journal
            mode="cashier"
            login={login}
            onSessionExpired={onSessionExpired}
            onRefresh={onBalancesStale}
            onBalances={onSaved}
            onOperationChanged={setChanged}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
