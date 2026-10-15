import { KASSA_CURRENCIES, useKassa } from "./kassa";
import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import type { Balance, Category, Operation } from "./api";
import { CategoryField } from "./CategoryField";
import { ClientCodeField } from "./ClientCodeField";
import { CurrencyPicker } from "./CurrencyPicker";
import { EntryStatus } from "./EntryStatus";
import { AmountInput } from "./AmountInput";
import { formatMoney, formatMoscowTime, parseAmountInput, parseRateInput, type Currency } from "./money";
import { RateField } from "./RateField";
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
  /** The admin and the head cashier may add a client from the form. */
  canAddClients?: boolean;
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
  categories,
  onReloadCategories,
  canAddClients = false,
  active,
}: Props) {
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  // Empty to start with, and again after each entry: an expense without a rate is counted at the average of its day.
  const [rate, setRate] = useState("");
  const [clientCode, setClientCode] = useState("");
  const [trip, setTrip] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [employee, setEmployee] = useState("");
  const [comment, setComment] = useState("");
  const amountInput = useRef<HTMLInputElement>(null);
  const { kassa } = useKassa();
  const entry = useEntry({ entryId, onSaved, onBalancesStale, onSessionExpired, changed, categories: categories ?? undefined });
  const chosen = categories?.find((item) => item.code === category && item.kind === "expense");

  // The cursor is in the amount whenever this form comes to the front (it is kept alive when it is hidden).
  useEffect(() => {
    if (active) amountInput.current?.focus();
  }, [active]);

  const needsClient = chosen?.requiresClient ?? false;
  const needsTrip = chosen?.requiresTrip ?? false;
  const needsCounterparty = chosen?.requiresCounterparty ?? false;
  const needsEmployee = chosen?.requiresEmployee ?? false;

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
    // The rate of an expense is optional: left empty, the average rate of the ruble incomes of the day is used.
    const rateE4 = currency === "RUB" && rate.trim() !== "" ? parseRateInput(rate) : null;
    if (currency === "RUB" && rate.trim() !== "" && rateE4 === null) {
      entry.setError("Курс введён неверно: сколько рублей за 1 доллар, например 79 или 78,5. Или оставьте поле пустым.");
      return;
    }
    const code = clientCode.trim();
    if (needsClient && code === "") {
      entry.setError(`Для категории «${chosen!.label}» введите код клиента.`);
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
      type: "expense",
      id,
      kassa,
      amountMinor,
      currency,
      ...(rateE4 === null ? {} : { rateE4 }),
      category,
      clientCode: needsClient ? code : undefined,
      ...(needsTrip && tripNumber !== null ? { tripNumber } : {}),
      ...(needsCounterparty ? { counterparty: party } : {}),
      ...(needsEmployee ? { employee: person } : {}),
      comment: comment.trim() || undefined,
    }));
    if (saved) {
      setAmount("");
      setRate("");
      setClientCode("");
      setTrip("");
      setCounterparty("");
      setEmployee("");
      setComment("");
      setCategory(null);
      amountInput.current?.focus();
    }
  }

  const savedLabel = categories?.find((item) => item.code === entry.saved?.category)?.label;

  return (
    <Card asChild className="gap-4 p-5">
    <form onSubmit={submit}>
      <h2 className="sr-only">Расход</h2>

      <EntryStatus note={entry.note}>
        {entry.saved?.type === "expense" && (
          <p className={cn(alertVariants({ variant: "success" }), "success")}>
            Записано: {savedLabel ?? "расход"}, {formatMoney(entry.saved.amountMinor, entry.saved.currency)}.{" "}
            <span className="when text-muted-foreground">{formatMoscowTime(entry.saved.createdAt)} (МСК)</span>
          </p>
        )}
      </EntryStatus>

      <CategoryField
        list={categories}
        kind="expense"
        label="На что ушли деньги"
        value={category}
        onChange={setCategory}
        onReload={onReloadCategories}
      />

      {needsClient && <ClientCodeField value={clientCode} onChange={setClientCode} inside canAdd={canAddClients} onSessionExpired={onSessionExpired} />}

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

      <Label>
        <span className="sr-only">Сумма</span>
        <AmountInput
          ref={amountInput}
          name="amount"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="Сумма"
          required
          value={amount}
          onChange={setAmount}
        />
      </Label>

      {currency === "RUB" && <RateField value={rate} onChange={setRate} required={false} inside />}

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
        {entry.busy ? "Записываем…" : "Записать расход"}
      </Button>
    </form>
    </Card>
  );
}
