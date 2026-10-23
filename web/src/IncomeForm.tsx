import { KASSA_CURRENCIES, useKassa } from "./kassa";
import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { activeCategories, DEFAULT_INCOME_CATEGORY, type Balance, type Category, type Operation } from "./api";
import { CategoryField } from "./CategoryField";
import { ClientCodeField } from "./ClientCodeField";
import { CurrencyPicker } from "./CurrencyPicker";
import { EntryStatus } from "./EntryStatus";
import { AmountInput } from "./AmountInput";
import { formatMoney, formatRateInput, parseAmountInput, parseRateInput, type Currency } from "./money";
import { RateField } from "./RateField";
import { rememberedRate } from "./remembered-rate";
import { TripFields, parseTripNumber } from "./TripFields";
import { useEntry } from "./useEntry";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  entryId: MutableRefObject<string>;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
  /** The lists of categories (see `useCategories`). */
  categories: Category[] | null | undefined;
  onReloadCategories: () => void;
  /** The operation last corrected or deleted in the journal (see useEntry). */
  changed?: Operation | null;
  /** The form is on the screen (and not hidden behind the other one or the journal). */
  active: boolean;
};

/** The one income category that the phone can do without a list for. */
const FALLBACK_CATEGORIES: Category[] = [
  {
    code: DEFAULT_INCOME_CATEGORY,
    kind: "income",
    label: "Оплата от клиента",
    sortOrder: 1,
    archived: false,
    requiresClient: true,
    requiresTrip: false,
    requiresCounterparty: false,
    requiresEmployee: false,
    countsAsCost: true,
    notifyGroup: true,
  },
];

export function IncomeForm({
  entryId,
  currency,
  onCurrencyChange,
  onSaved,
  onBalancesStale,
  onSessionExpired,
  changed,
  categories,
  onReloadCategories,
  active,
}: Props) {
  const [amount, setAmount] = useState("");
  // The rate of the last entry of today is there to start with: the cashier sees it, and changes it when it has moved.
  const [rate, setRate] = useState(() => {
    const kept = rememberedRate();
    return kept === null ? "" : formatRateInput(kept);
  });
  const [category, setCategory] = useState<string | null>(null);
  const [clientCode, setClientCode] = useState("");
  const [trip, setTrip] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [employee, setEmployee] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const { kassa } = useKassa();
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed, categories: categories ?? undefined });

  // Without the lists (never loaded, nothing kept on the phone) an income can still be entered: it is a payment of a client.
  const lists = categories === undefined ? FALLBACK_CATEGORIES : categories;
  const choices = lists ? activeCategories(lists, "income") : [];
  // The first of the owner's list to start with, or the payment of a client when it is there: most incomes are.
  useEffect(() => {
    if (category === null && choices.length > 0) {
      setCategory((choices.find((item) => item.code === DEFAULT_INCOME_CATEGORY) ?? choices[0]!).code);
    }
  }, [category, choices]);
  const chosen = choices.find((item) => item.code === category);
  // What the income that was just saved was, said when it is not the usual payment of a client.
  const savedCode = entry.saved?.category ?? null;
  const savedCategory =
    savedCode !== null && savedCode !== DEFAULT_INCOME_CATEGORY ? lists?.find((item) => item.code === savedCode)?.label : undefined;
  const needsClient = chosen?.requiresClient ?? false;
  const needsTrip = chosen?.requiresTrip ?? false;
  const needsCounterparty = chosen?.requiresCounterparty ?? false;
  const needsEmployee = chosen?.requiresEmployee ?? false;

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
    const rateE4 = currency === "RUB" ? parseRateInput(rate) : null;
    if (currency === "RUB" && rateE4 === null) {
      entry.setError("Введите курс: сколько рублей за 1 доллар, например 79 или 78,5.");
      return;
    }
    if (category === null || !chosen) {
      entry.setError("Выберите, откуда деньги.");
      return;
    }
    const code = clientCode.trim();
    if (needsClient && code === "") {
      entry.setError("Введите код клиента.");
      return;
    }
    const tripNumber = parseTripNumber(trip);
    const party = counterparty.trim();
    const person = employee.trim();
    if (needsTrip && tripNumber === null) {
      entry.setError("Введите номер рейса: число, например 194.");
      return;
    }
    if (needsCounterparty && party === "") {
      entry.setError("Введите контрагента.");
      return;
    }
    if (needsEmployee && person === "") {
      entry.setError("Введите сотрудника.");
      return;
    }

    const saved = await entry.send((id) => ({
      type: "income",
      id,
      kassa,
      amountMinor,
      currency,
      ...(rateE4 === null ? {} : { rateE4 }),
      category,
      ...(needsClient ? { clientCode: code } : {}),
      ...(needsTrip && tripNumber !== null ? { tripNumber } : {}),
      ...(needsCounterparty ? { counterparty: party } : {}),
      ...(needsEmployee ? { employee: person } : {}),
      comment: comment.trim() || undefined,
    }));
    if (saved) {
      setAmount("");
      setClientCode("");
      setTrip("");
      setCounterparty("");
      setEmployee("");
      setComment("");
      amountInput.current?.focus();
    }
  }

  return (
    <Card asChild className="gap-4 p-5">
    <form onSubmit={submit}>
      <h2 className="sr-only">Приход</h2>

      <EntryStatus note={entry.note}>
        {entry.saved?.type === "income" && (
          <p className={cn(alertVariants({ variant: "success" }), "success")}>
            Записано: приход {formatMoney(entry.saved.amountMinor, entry.saved.currency)}
            {savedCategory ? ` (${savedCategory})` : ""}
            {entry.saved.clientCode ? `, клиент ${entry.saved.clientCode}` : ""}.
          </p>
        )}
      </EntryStatus>

      <CategoryField list={lists} kind="income" label="Откуда деньги" value={category} onChange={setCategory} onReload={onReloadCategories} />

      {needsClient && <ClientCodeField value={clientCode} onChange={setClientCode} inside />}

      <TripFields
        needsTrip={needsTrip}
        needsCounterparty={needsCounterparty}
        trip={trip}
        onTripChange={setTrip}
        counterparty={counterparty}
        onCounterpartyChange={setCounterparty}
        needsEmployee={needsEmployee}
        employee={employee}
        onEmployeeChange={setEmployee}
        inside
      />

      {/* Andijan keeps dollars only: nothing to choose. */}
      {KASSA_CURRENCIES[kassa].length > 1 && <CurrencyPicker value={currency} onChange={onCurrencyChange} />}

      <Label className="relative">
        <span className="sr-only">Сумма</span>
        {/* The amount is the field of the form: a little bigger and bolder than the others, the currency in it. */}
        <AmountInput
          ref={amountInput}
          name="amount"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="Сумма"
          required
          value={amount}
          onChange={setAmount}
          className="h-14 pr-12 text-[21px] font-semibold tracking-tight placeholder:text-base placeholder:font-normal placeholder:tracking-normal"
        />
        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-base font-semibold text-muted-foreground">
          {currency === "RUB" ? "₽" : "$"}
        </span>
      </Label>

      {currency === "RUB" && <RateField value={rate} onChange={setRate} required inside />}

      <Label>
        <span className="sr-only">Комментарий</span>
        <Input
          placeholder="Комментарий"
          name="comment"
          type="text"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={500}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </Label>

      {entry.error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {entry.error}
        </p>
      )}

      <Button type="submit" size="lg" disabled={entry.busy}>
        {entry.busy ? "Записываем…" : "Записать приход"}
      </Button>
    </form>
    </Card>
  );
}
