import { AmountInput } from "./AmountInput";
import { Label, LabelNote } from "@/components/ui/label";

type Props = {
  value: string;
  onChange: (text: string) => void;
  /** An income in rubles must have its rate; for an expense it is optional (the average of the day is used). */
  required: boolean;
};

/** The rate (rubles for one dollar) of a ruble entry, with what to do when it is not known. */
export function RateField({ value, onChange, required }: Props) {
  return (
    <>
      <Label>
        <span>
          Курс <LabelNote>{required ? "(рублей за 1 $)" : "(рублей за 1 $, необязательно)"}</LabelNote>
        </span>
        <AmountInput
          name="rate"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="например 79,5"
          decimals={4}
          wholeDigits={4}
          required={required}
          value={value}
          onChange={onChange}
        />
      </Label>
      {!required && (
        <p className="-mt-2 mb-0 text-sm text-muted-foreground">Не знаете курс? Оставьте пустым: возьмём средний курс приходов за этот день.</p>
      )}
    </>
  );
}
