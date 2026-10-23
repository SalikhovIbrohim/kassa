import { CURRENCIES, CURRENCY_NAME, type Currency } from "./money";
import { cn } from "@/lib/utils";

type Props = {
  value: Currency;
  onChange: (currency: Currency) => void;
};

/** Rubles or dollars: two big buttons that are radio buttons underneath, so a tap anywhere on them picks one. */
export function CurrencyPicker({ value, onChange }: Props) {
  return (
    // The segment of the prototype: a grey capsule, the chosen currency filled black (white in the dark theme).
    <fieldset className="m-0 grid min-w-0 grid-cols-2 gap-0.5 rounded-full border border-input-edge bg-muted p-1">
      <legend className="sr-only">Валюта</legend>
      {CURRENCIES.map((code) => (
        <label
          key={code}
          data-slot="choice"
          className={cn(
            "relative flex h-12 cursor-pointer items-center justify-center rounded-full px-3 text-base font-semibold transition-[background-color,color] duration-200 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
            code === value ? "bg-primary text-primary-foreground shadow-[0_2px_6px_rgba(10,12,16,0.16)]" : "text-muted-foreground hover:text-foreground",
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
