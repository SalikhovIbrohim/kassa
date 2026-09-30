import { CURRENCIES, CURRENCY_NAME, formatMoney } from "./money";
import type { Balance } from "./api";

type Props = {
  /** Null while loading, undefined when loading failed. */
  balances: Balance[] | null | undefined;
  onRetry: () => void;
};

export function Balances({ balances, onRetry }: Props) {
  if (balances === undefined) {
    return (
      <section className="card" aria-label="Остатки">
        <p className="error" role="alert">
          Не удалось загрузить остатки.
        </p>
        <button type="button" className="secondary" onClick={onRetry}>
          Повторить
        </button>
      </section>
    );
  }

  return (
    <section className="balances" aria-label="Остатки">
      {CURRENCIES.map((currency) => {
        const balance = balances?.find((item) => item.currency === currency);
        return (
          <div className="balance" key={currency}>
            <span className="balance-name">{CURRENCY_NAME[currency]}</span>
            <strong
              className={balance && balance.amountMinor < 0 ? "balance-amount negative" : "balance-amount"}
              data-currency={currency}
            >
              {balance ? formatMoney(balance.amountMinor, currency) : "…"}
            </strong>
          </div>
        );
      })}
    </section>
  );
}
