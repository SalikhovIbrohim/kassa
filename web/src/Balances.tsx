import type { CSSProperties } from "react";
import { CURRENCIES, CURRENCY_NAME, formatMoney, type Currency } from "./money";
import type { Balance } from "./api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { alertVariants } from "@/components/ui/alert";

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
      <Card role="region" aria-label="Остатки" className="gap-3 p-4">
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Не удалось загрузить остатки.
        </p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Повторить
        </Button>
      </Card>
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
    // The class "balances" is also what the journal's wide page narrows to the width of a phone (screens.css).
    <section className="balances grid grid-cols-2 gap-3" aria-label="Остатки" style={{ "--chars": longest } as CSSProperties}>
      {CURRENCIES.map((currency) => {
        const balance = known?.find((item) => item.currency === currency);
        const shown = shownFor(currency);
        return (
          <Card key={currency} className="min-w-0 gap-1 py-3">
            {/* The amount is sized by the width of this box (see .balance-amount in index.css). */}
            <CardContent className="grid min-w-0 gap-1 px-3.5 [container-type:inline-size]">
              <strong aria-label={`${CURRENCY_NAME[currency]}: ${shown}`} className={cn("balance-amount", balance && balance.amountMinor < 0 && "text-destructive")} data-currency={currency}>
                {shown}
              </strong>
            </CardContent>
          </Card>
        );
      })}
      {unsent > 0 && (
        <p className="hint balances-unsent col-span-2">
          Без учёта неотправленных записей: {unsent}.{" "}
          <a href="#queue">Показать</a>
        </p>
      )}
      {balances === "offline" && (
        <p className="hint balances-offline col-span-2">
          Нет связи: остатков не видно. Они появятся, когда связь вернётся.{" "}
          <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={onRetry}>
            Проверить
          </Button>
        </p>
      )}
    </section>
  );
}
