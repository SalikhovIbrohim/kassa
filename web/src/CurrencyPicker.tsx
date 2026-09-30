import { CURRENCIES, CURRENCY_NAME, type Currency } from "./money";

type Props = {
  value: Currency;
  onChange: (currency: Currency) => void;
};

export function CurrencyPicker({ value, onChange }: Props) {
  return (
    <fieldset className="choices">
      <legend>Валюта</legend>
      {CURRENCIES.map((code) => (
        <label key={code} className={code === value ? "choice chosen" : "choice"}>
          <input
            type="radio"
            name="currency"
            value={code}
            checked={code === value}
            onChange={() => onChange(code)}
          />
          {CURRENCY_NAME[code]}
        </label>
      ))}
    </fieldset>
  );
}
