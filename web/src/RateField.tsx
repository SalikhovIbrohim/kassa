import { AmountInput } from "./AmountInput";
import { Label } from "@/components/ui/label";

type Props = {
  value: string;
  onChange: (text: string) => void;
  /** An income in rubles must have its rate; for an expense it is optional (the average of the day is used). */
  required: boolean;
  /** The name stands inside the empty field instead of above it (the entry forms). */
  inside?: boolean;
};

/** The rate (rubles for one dollar) of a ruble entry. Left empty on an expense, the average rate of the day is used. */
export function RateField({ value, onChange, required, inside = false }: Props) {
  return (
    <Label>
      {inside ? <span className="sr-only">Курс</span> : "Курс"}
      <AmountInput
        placeholder={inside ? "Курс" : undefined}
        name="rate"
        autoComplete="off"
        enterKeyHint="next"
        decimals={4}
        wholeDigits={4}
        required={required}
        value={value}
        onChange={onChange}
      />
    </Label>
  );
}
