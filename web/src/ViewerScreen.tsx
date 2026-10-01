import { useState } from "react";
import { Journal } from "./Journal";
import { Totals } from "./Totals";

type Props = {
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh: () => void;
};

type Section = "journal" | "totals";

/** The viewer's screen: the journal of everybody's operations, and the totals of a period. Nothing is entered here. */
export function ViewerScreen({ onSessionExpired, onRefresh }: Props) {
  const [section, setSection] = useState<Section>("journal");
  // The totals are made on first use, and both stay alive, only hidden, while the other is open: filters that
  // were set in the journal, and the period chosen for the totals, are still there when the viewer comes back.
  const [totalsOpened, setTotalsOpened] = useState(false);

  const open = (next: Section) => {
    if (next === "totals") setTotalsOpened(true);
    setSection(next);
  };

  return (
    <>
      <div className="tabs" role="group" aria-label="Раздел">
        <button type="button" className={section === "journal" ? "tab active" : "tab"} aria-pressed={section === "journal"} onClick={() => open("journal")}>
          Журнал
        </button>
        <button type="button" className={section === "totals" ? "tab active" : "tab"} aria-pressed={section === "totals"} onClick={() => open("totals")}>
          Итоги
        </button>
      </div>

      <div hidden={section !== "journal"}>
        <Journal mode="viewer" onSessionExpired={onSessionExpired} onRefresh={onRefresh} />
      </div>
      {totalsOpened && (
        <div hidden={section !== "totals"}>
          <Totals onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "totals"} />
        </div>
      )}
    </>
  );
}
