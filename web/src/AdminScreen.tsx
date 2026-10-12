import { useState } from "react";
import type { Balance } from "./api";
import { EntryScreen } from "./EntryScreen";
import { ViewerScreen } from "./ViewerScreen";

type Props = {
  login: string;
  onSaved: (balances: Balance[]) => void;
  onBalancesStale: () => void;
  onSessionExpired: () => void;
};

type Side = "cash" | "manage";

/**
 * The admin's screen: he stands above the owner, so he has both. "Касса" is the cashier's screen (the forms, the journal,
 * the button that counts the cash), "Управление" the owner's (the journal with its filters and the deleted entries, the
 * totals, the counts of the cash, the lists of categories). Both stay alive, only hidden, while the other is open: what
 * he was typing, and the filters he set, are there when he comes back.
 */
export function AdminScreen({ login, onSaved, onBalancesStale, onSessionExpired }: Props) {
  const [side, setSide] = useState<Side>("cash");
  // The owner's screen is made on first use: it asks the server for a good deal.
  const [manageOpened, setManageOpened] = useState(false);

  const show = (next: Side) => {
    if (next === "manage") setManageOpened(true);
    setSide(next);
  };

  return (
    <>
      <div className="presets side-switch" role="group" aria-label="Режим">
        <button type="button" className={side === "cash" ? "secondary small chosen" : "secondary small"} aria-pressed={side === "cash"} onClick={() => show("cash")}>
          Касса
        </button>
        <button type="button" className={side === "manage" ? "secondary small chosen" : "secondary small"} aria-pressed={side === "manage"} onClick={() => show("manage")}>
          Управление
        </button>
      </div>

      <div hidden={side !== "cash"}>
        <EntryScreen login={login} admin onSaved={onSaved} onBalancesStale={onBalancesStale} onSessionExpired={onSessionExpired} />
      </div>
      {manageOpened && (
        <div hidden={side !== "manage"}>
          <ViewerScreen onSessionExpired={onSessionExpired} onRefresh={onBalancesStale} />
        </div>
      )}
    </>
  );
}
