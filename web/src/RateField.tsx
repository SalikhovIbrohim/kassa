import { AmountInput } from "./AmountInput";

type Props = {
  value: string;
  onChange: (text: string) => void;
  /** An income in rubles must have its rate; for an expense it is optional (the average of the shift is used). */
  required: boolean;
};

/** The rate (rubles for one dollar) of a ruble entry, with what to do when it is not known. */
export function RateField({ value, onChange, required }: Props) {
  return (
    <>
      <label>
        <span>
          Курс <span className="optional">{required ? "(рублей за 1 $)" : "(рублей за 1 $, необязательно)"}</span>
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
      </label>
      {!required && (
        <p className="hint">Не знаете курс? Оставьте пустым: после закрытия смены возьмём средний курс прихода.</p>
      )}
    </>
  );
}
