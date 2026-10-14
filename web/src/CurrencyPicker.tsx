import { CURRENCIES, CURRENCY_NAME, type Currency } from "./money";
import { cn } from "@/lib/utils";

type Props = {
  value: Currency;
  onChange: (currency: Currency) => void;
};

/** Rubles or dollars: two big buttons that are radio buttons underneath, so a tap anywhere on them picks one. */
export function CurrencyPicker({ value, onChange }: Props) {
  return (
    <fieldset className="m-0 grid min-w-0 grid-cols-2 gap-2.5 border-0 p-0">
      <legend className="sr-only">Валюта</legend>
      {CURRENCIES.map((code) => (
        <label
          key={code}
          data-slot="choice"
          className={cn(
            "relative flex h-12 cursor-pointer items-center justify-center rounded-md border px-3 text-base font-semibold transition-colors has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
            code === value ? "border-primary bg-primary text-primary-foreground shadow-xs" : "border-input bg-card text-foreground hover:bg-accent",
          )}
        >
          <input
            type="radio"
            name="currency"
            value={code}
            checked={code === value}
            onChange={() => onChange(code)}
            data-slot="choice-input"
            className="absolute size-px opacity-0"
          />
          {CURRENCY_NAME[code]}
        </label>
      ))}
    </fieldset>
  );
}
