import type { CSSProperties } from "react";
import { CURRENCIES, CURRENCY_NAME, formatMoney, type Currency } from "./money";
import type { Balance } from "./api";

/** Null while loading, undefined when loading failed, "offline" when the server could not be reached. */
export type BalancesState = Balance[] | null | undefined | "offline";

type Props = {
  balances: BalancesState;
  onRetry: () => void;
  /** Entries of this cashier that are on the phone and not on the server: the balances do not count them. */
  unsent?: number;
};

export function Balances({ balances, onRetry, unsent = 0 }: Props) {
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

  const known = Array.isArray(balances) ? balances : undefined;
  const shownFor = (currency: Currency) => {
    const balance = known?.find((item) => item.currency === currency);
    return balance ? formatMoney(balance.amountMinor, currency) : balances === "offline" ? "—" : "…";
  };
  // Both amounts share the size that fits the longer one, so the two cards match.
  const longest = Math.max(...CURRENCIES.map((currency) => shownFor(currency).length));

  return (
    <section className="balances" aria-label="Остатки" style={{ "--chars": longest } as CSSProperties}>
      {CURRENCIES.map((currency) => {
        const balance = known?.find((item) => item.currency === currency);
        const shown = shownFor(currency);
        return (
          <div className="balance" key={currency}>
            <span className="balance-name">{CURRENCY_NAME[currency]}</span>
            <strong
              className={balance && balance.amountMinor < 0 ? "balance-amount negative" : "balance-amount"}
              data-currency={currency}
            >
              {shown}
            </strong>
          </div>
        );
      })}
      {unsent > 0 && (
        <p className="hint balances-unsent">
          Без учёта неотправленных записей: {unsent}.{" "}
          <a href="#queue">Показать</a>
        </p>
      )}
      {balances === "offline" && (
        <p className="hint balances-offline">
          Нет связи: остатков не видно. Они появятся, когда связь вернётся.{" "}
          <button type="button" className="link" onClick={onRetry}>
            Проверить
          </button>
        </p>
      )}
    </section>
  );
}
