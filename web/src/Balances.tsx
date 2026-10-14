import type { Balance } from "./api";
import { Button } from "@/components/ui/button";

/** Null while loading, undefined when loading failed, "offline" when the server could not be reached. */
export type BalancesState = Balance[] | null | undefined | "offline";

type Props = {
  balances: BalancesState;
  onRetry: () => void;
  /** Entries of this cashier that are on the phone and not on the server: the balances do not count them. */
  unsent?: number;
};

/**
 * What the balances in the header do not say by themselves: that entries on the phone are not counted yet, or that
 * there is no connection. Nothing when all is well.
 */
export function BalanceNotes({ balances, onRetry, unsent = 0 }: Props) {
  if (unsent === 0 && balances !== "offline") return null;
  return (
    <div className="grid gap-1">
      {unsent > 0 && (
        <p className="hint balances-unsent m-0">
          Остатки без учёта неотправленных записей: {unsent}. <a href="#queue">Показать</a>
        </p>
      )}
      {balances === "offline" && (
        <p className="hint balances-offline m-0">
          Нет связи: остатков не видно. Они появятся, когда связь вернётся.{" "}
          <Button type="button" variant="link" className="h-auto p-0 align-baseline" onClick={onRetry}>
            Проверить
          </Button>
        </p>
      )}
    </div>
  );
}
