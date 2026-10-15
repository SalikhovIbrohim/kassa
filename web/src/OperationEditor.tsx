import { KASSA_CURRENCIES } from "./kassa";
import { useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_INCOME_CATEGORY,
  editOperation,
  NetworkError,
  type Balance,
  type Category,
  type EditInput,
  type Operation,
} from "./api";
import { CategoryField } from "./CategoryField";
import { ClientCodeField } from "./ClientCodeField";
import { explainFailure, NO_CONNECTION } from "./changeMessages";
import { CurrencyPicker } from "./CurrencyPicker";
import { AmountInput } from "./AmountInput";
import { formatAmountInput, formatRateInput, parseAmountInput, parseRateInput, type Currency } from "./money";
import { RateField } from "./RateField";
import { TripFields, parseTripNumber } from "./TripFields";
import { usePanelEntrance } from "./usePanelEntrance";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  operation: Operation;
  categories: Category[];
  onSaved: (operation: Operation, balances: Balance[]) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
  /** The operation no longer exists as it was (deleted elsewhere): say so and refresh the journal. */
  onGone: (message: string) => void;
  /** The list of categories did not load: ask for it again. */
  onReloadCategories: () => void;
};

/**
 * Corrects one operation: the same fields as when it was written (the type never changes),
 * starting from what it says now, and an optional reason.
 */
export function OperationEditor({
  operation,
  categories,
  onSaved,
  onCancel,
  onSessionExpired,
  onGone,
  onReloadCategories,
}: Props) {
  const isIncome = operation.type === "income";
  const [currency, setCurrency] = useState<Currency>(operation.currency);
  const [amount, setAmount] = useState(formatAmountInput(operation.amountMinor));
  const [rate, setRate] = useState(operation.rateE4 === null ? "" : formatRateInput(operation.rateE4));
  // An income from before there were categories of income is a payment of a client.
  const [category, setCategory] = useState<string | null>(operation.category ?? (isIncome ? DEFAULT_INCOME_CATEGORY : null));
  const [clientCode, setClientCode] = useState(operation.clientCode ?? "");
  const [trip, setTrip] = useState(operation.tripNumber ? String(operation.tripNumber) : "");
  const [counterparty, setCounterparty] = useState(operation.counterparty ?? "");
  const [employee, setEmployee] = useState(operation.employee ?? "");
  const [comment, setComment] = useState(operation.comment ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const { root, heading } = usePanelEntrance<HTMLFormElement>();

  const chosen = categories.find((item) => item.code === category && item.kind === operation.type);
  const needsClient = chosen?.requiresClient ?? false;
  const needsTrip = chosen?.requiresTrip ?? false;
  const needsCounterparty = chosen?.requiresCounterparty ?? false;
  const needsEmployee = chosen?.requiresEmployee ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const amountMinor = parseAmountInput(amount);
    if (amountMinor === null) {
      setError("Введите сумму больше нуля, например 1500 или 1500,50.");
      amountInput.current?.focus();
      return;
    }
    // An income in rubles must have its rate; for an expense it may stay empty (the average of its day is used).
    const rateText = currency === "RUB" ? rate.trim() : "";
    const rateE4 = rateText === "" ? null : parseRateInput(rateText);
    if (currency === "RUB" && (isIncome || rateText !== "") && rateE4 === null) {
      setError(
        isIncome
          ? "Введите курс: сколько рублей за 1 доллар, например 79 или 78,5."
          : "Курс введён неверно: сколько рублей за 1 доллар, например 79 или 78,5. Или оставьте поле пустым.",
      );
      return;
    }
    if (category === null || !chosen) {
      setError(isIncome ? "Выберите, откуда деньги." : "Выберите, на что ушли деньги.");
      return;
    }
    const code = clientCode.trim();
    if (needsClient && code === "") {
      setError(`Для категории «${chosen.label}» введите код клиента.`);
      return;
    }
    const tripNumber = parseTripNumber(trip);
    const party = counterparty.trim();
    const person = employee.trim();
    if (needsTrip && tripNumber === null) {
      setError("Введите номер рейса: число, например 194.");
      return;
    }
    if (needsCounterparty && party === "") {
      setError("Введите контрагента.");
      return;
    }
    if (needsEmployee && person === "") {
      setError("Введите сотрудника.");
      return;
    }

    const common = {
      amountMinor,
      currency,
      ...(rateE4 === null ? {} : { rateE4 }),
      ...(needsTrip && tripNumber !== null ? { tripNumber } : {}),
      ...(needsCounterparty ? { counterparty: party } : {}),
      ...(needsEmployee ? { employee: person } : {}),
      comment: comment.trim() || undefined,
      reason: reason.trim() || undefined,
    };
    const input: EditInput = isIncome
      ? { type: "income", category, clientCode: needsClient ? code : undefined, ...common }
      : {
          type: "expense",
          category,
          // There is no field «Кому выдали» any more (the counterparty and the employee say who): an older entry keeps what it had.
          recipient: operation.recipient ?? undefined,
          clientCode: needsClient ? code : undefined,
          ...common,
        };

    setBusy(true);
    setError(null);
    try {
      const result = await editOperation(operation.id, input);
      if (result.ok) {
        onSaved(result.operation, result.balances);
        return;
      }
      if (result.reason === "session-expired") {
        onSessionExpired();
        return;
      }
      if (result.reason === "deleted" || result.reason === "not-found") {
        onGone(`${explainFailure(result)} Журнал обновлён.`);
        return;
      }
      setError(explainFailure(result));
    } catch (caught) {
      setError(caught instanceof NetworkError ? NO_CONNECTION : "Не получилось сохранить. Попробуйте ещё раз.");
    }
    setBusy(false);
  }

  return (
    <form className="panel-body" onSubmit={submit} aria-label="Изменить запись" ref={root}>
      <h3 ref={heading} tabIndex={-1}>
        Изменить запись
      </h3>

      {/* Andijan keeps dollars only: its entries stay in dollars. */}
      {KASSA_CURRENCIES[operation.kassa ?? "moscow"].length > 1 && <CurrencyPicker value={currency} onChange={setCurrency} />}

      <Label>
        Сумма
        <AmountInput
          ref={amountInput}
          name="amount"
          autoComplete="off"
          required
          value={amount}
          onChange={setAmount}
        />
      </Label>

      {currency === "RUB" && <RateField value={rate} onChange={setRate} required={isIncome} />}

      <CategoryField
        list={categories.length > 0 ? categories : undefined}
        kind={operation.type}
        label={isIncome ? "Откуда деньги" : "На что ушли деньги"}
        value={category}
        onChange={setCategory}
        onReload={onReloadCategories}
        keep={operation.category}
      />

      {needsClient && <ClientCodeField value={clientCode} onChange={setClientCode} />}

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
      />

      <Label>
        <span>
          Комментарий
        </span>
        <Input
          name="comment"
          type="text"
          autoComplete="off"
          maxLength={500}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </Label>

      <Label>
        <span>
          Причина правки
        </span>
        <Input
          name="reason"
          type="text"
          autoComplete="off"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Label>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}

      <div className="panel-buttons">
        <Button type="submit" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
