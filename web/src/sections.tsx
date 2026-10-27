import { useCallback, useState } from "react";
import type { Role } from "./api";

/** The places of the app, one menu for everybody: who sees which is the role's (see `SECTIONS`). */
export type SectionKey =
  | "income"
  | "expense"
  | "journal"
  | "reconcile"
  | "totals"
  | "reconciliations"
  | "clients"
  | "categories"
  | "users"
  | "settings";

type SectionInfo = { label: string; icon: string; roles: readonly Role[] };

/** The icons of the prototype (design/kassa.html), drawn in a 24 by 24 box with one stroke. */
const ICONS = {
  income: "M12 4v11M7 10l5 5 5-5M5 19.5h14",
  expense: "M12 20V9M7 14l5-5 5 5M5 4.5h14",
  journal: "M6 4h12a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zM9 8h6M9 11.5h6M5 18a2 2 0 0 1 2-2h12",
  reconcile: "M12 4v16M8 20h8M4 7h16M7 7l-3 7h6zM17 7l-3 7h6z",
  totals: "M5 20V11M10 20V5M15 20v-7M20 20v-4M3 20h18",
  reconciliations: "M9 3.5h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 14l2 2 4-4",
  clients: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.8.7 3 2.6 3 5.2",
  categories: "M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5zM8 8.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
  users: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM12 12a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8.5 16.5c.7-1.4 2-2.2 3.5-2.2s2.8.8 3.5 2.2",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronDown: "M6 9l6 6 6-6",
  logout: "M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M14 8l4 4-4 4M18 12H9",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5M4 4v3.5h3.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-3.5h-3.5",
} as const;

export type IconName = keyof typeof ICONS;

/** An icon of the prototype, in the color of the text around it. */
export function Icon({ name, size = 22, stroke = 1.8, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "none" }}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export const SECTIONS: Record<SectionKey, SectionInfo> = {
  income: { label: "Приход", icon: "income", roles: ["cashier", "head_cashier", "admin"] },
  expense: { label: "Расход", icon: "expense", roles: ["cashier", "head_cashier", "admin"] },
  journal: { label: "Журнал", icon: "journal", roles: ["cashier", "head_cashier", "admin", "viewer"] },
  reconcile: { label: "Сверка", icon: "reconcile", roles: ["head_cashier"] },
  totals: { label: "Итоги", icon: "totals", roles: ["admin", "viewer"] },
  reconciliations: { label: "Сверки", icon: "reconciliations", roles: ["admin", "viewer"] },
  clients: { label: "Клиенты", icon: "clients", roles: ["admin", "viewer"] },
  categories: { label: "Категории", icon: "categories", roles: ["admin"] },
  users: { label: "Люди", icon: "users", roles: ["admin"] },
  settings: { label: "Настройки", icon: "settings", roles: ["cashier", "head_cashier", "admin", "viewer"] },
};

const ORDER: readonly SectionKey[] = ["income", "expense", "journal", "reconcile", "totals", "reconciliations", "clients", "categories", "users", "settings"];

/** The menu of a computer, in groups as in the prototype. */
export const GROUPS: ReadonlyArray<{ title: string | null; keys: readonly SectionKey[] }> = [
  { title: "Касса", keys: ["income", "expense"] },
  { title: null, keys: ["journal", "reconcile", "totals", "reconciliations"] },
  { title: "Справочники", keys: ["clients"] },
  { title: "Настройки", keys: ["categories", "users", "settings"] },
];

export const sectionsOf = (role: Role): SectionKey[] => ORDER.filter((key) => SECTIONS[key].roles.includes(role));

/** The four buttons of the tab bar a role starts with (the fifth is always «Настройки»). */
const DEFAULT_TABS: Record<Role, readonly SectionKey[]> = {
  cashier: ["income", "expense", "journal"],
  head_cashier: ["income", "expense", "journal", "reconcile"],
  admin: ["income", "journal", "totals", "clients"],
  viewer: ["journal", "totals", "reconciliations", "clients"],
};
export const TAB_SLOTS = 4;

const tabsKey = (role: Role) => `kassa.tabs.${role}`;

function storedTabs(role: Role): SectionKey[] {
  const allowed: SectionKey[] = sectionsOf(role).filter((key) => key !== "settings");
  try {
    const saved = JSON.parse(localStorage.getItem(tabsKey(role)) ?? "null") as unknown;
    if (Array.isArray(saved)) {
      const kept = saved.filter((key): key is SectionKey => allowed.includes(key as SectionKey));
      if (kept.length > 0) return kept.slice(0, TAB_SLOTS);
    }
  } catch {
    // nothing kept, or something unreadable: the role's own
  }
  return DEFAULT_TABS[role].filter((key) => allowed.includes(key));
}

/**
 * The buttons of the tab bar of a phone: four the person chooses (kept on this device, one choice for each role), and
 * «Настройки» last, from where every other section opens.
 */
export function useTabs(role: Role): { tabs: SectionKey[]; chosen: SectionKey[]; setChosen: (keys: SectionKey[] | null) => void } {
  const [chosen, setChosenState] = useState<SectionKey[]>(() => storedTabs(role));
  const setChosen = useCallback(
    (keys: SectionKey[] | null) => {
      try {
        if (keys === null) localStorage.removeItem(tabsKey(role));
        else localStorage.setItem(tabsKey(role), JSON.stringify(keys.slice(0, TAB_SLOTS)));
      } catch {
        // not kept: this visit only
      }
      setChosenState(keys === null ? DEFAULT_TABS[role].filter((key) => sectionsOf(role).includes(key)) : keys.slice(0, TAB_SLOTS));
    },
    [role],
  );
  return { tabs: [...chosen, "settings"], chosen, setChosen };
}
