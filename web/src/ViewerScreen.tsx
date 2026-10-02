import { useState } from "react";
import { CategoriesAdmin } from "./CategoriesAdmin";
import { Journal } from "./Journal";
import { ShiftsList } from "./ShiftsList";
import { Totals } from "./Totals";

type Props = {
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh: () => void;
};

type Section = "journal" | "totals" | "shifts" | "categories";

/** The viewer's (the owner's) screen: the journal of everybody's operations, the totals of a period, the shifts, the lists of categories. Nothing is entered here. */
export function ViewerScreen({ onSessionExpired, onRefresh }: Props) {
  const [section, setSection] = useState<Section>("journal");
  // The totals are made on first use, and both stay alive, only hidden, while the other is open: filters that
  // were set in the journal, and the period chosen for the totals, are still there when the viewer comes back.
  const [totalsOpened, setTotalsOpened] = useState(false);
  const [shiftsOpened, setShiftsOpened] = useState(false);
  const [categoriesOpened, setCategoriesOpened] = useState(false);

  const open = (next: Section) => {
    if (next === "totals") setTotalsOpened(true);
    if (next === "shifts") setShiftsOpened(true);
    if (next === "categories") setCategoriesOpened(true);
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
        <button type="button" className={section === "shifts" ? "tab active" : "tab"} aria-pressed={section === "shifts"} onClick={() => open("shifts")}>
          Смены
        </button>
        <button type="button" className={section === "categories" ? "tab active" : "tab"} aria-pressed={section === "categories"} onClick={() => open("categories")}>
          Категории
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
      {shiftsOpened && (
        <div hidden={section !== "shifts"}>
          <ShiftsList onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "shifts"} />
        </div>
      )}
      {categoriesOpened && (
        <div hidden={section !== "categories"}>
          <CategoriesAdmin onSessionExpired={onSessionExpired} active={section === "categories"} />
        </div>
      )}
    </>
  );
}
