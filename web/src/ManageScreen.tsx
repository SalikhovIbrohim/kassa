import { useState, type ReactNode, type Ref } from "react";
import type { BalancesState } from "./Balances";
import { CategoriesAdmin } from "./CategoriesAdmin";
import { ClientsAdmin } from "./ClientsAdmin";
import { Journal } from "./Journal";
import { ReconciliationsList } from "./ReconciliationsList";
import { Totals } from "./Totals";
import { UsersAdmin } from "./UsersAdmin";
import { Shell, type ShellGroup } from "./Shell";

type Section = "journal" | "totals" | "reconciliations" | "clients" | "categories" | "users";

const LABEL: Record<Section, string> = {
  journal: "Журнал",
  totals: "Итоги",
  reconciliations: "Сверки",
  clients: "Клиенты",
  categories: "Категории",
  users: "Люди",
};

type Props = {
  displayName: string;
  roleLabel: string;
  /** The admin's login: he also keeps the accounts (the section «Люди»). The owner has none. */
  admin?: string;
  balances: BalancesState;
  onRetryBalances: () => void;
  onLeave: () => void;
  leaveButton?: Ref<HTMLButtonElement>;
  /** The admin goes back to the cash desk from here (the switch at the top of the menu). The owner has no cash desk. */
  onCashDesk?: () => void;
  /** What the page has to say above any section: the confirmation before leaving, an error, the Telegram link. */
  notices?: ReactNode;
  /** Something of the menu itself (see `Shell`). */
  menuExtra?: ReactNode;
  onSessionExpired: () => void;
  onRefresh: () => void;
};

/**
 * «Управление»: the owner's screen, and the admin's second one. On a computer a menu on the left (the sections, then
 * the settings) and a header with the section, the balances and «Выйти»; on a phone the menu hides behind ☰. Every
 * section is made on first use and then stays alive, only hidden: the filters of the journal and the period of the
 * totals are still there when one comes back.
 */
export function ManageScreen(props: Props) {
  const { admin, onSessionExpired, onRefresh } = props;
  const [section, setSection] = useState<Section>("journal");
  const [opened, setOpened] = useState<ReadonlySet<Section>>(new Set(["journal"]));

  const item = (key: Section) => ({ key, label: LABEL[key] });
  const groups: ShellGroup[] = [
    { title: null, items: [item("journal"), item("totals"), item("reconciliations")] },
    { title: "Справочники", items: [item("clients")] },
    { title: "Настройки", items: admin === undefined ? [item("categories")] : [item("categories"), item("users")] },
  ];

  const open = (next: string) => {
    setOpened((previous) => new Set(previous).add(next as Section));
    setSection(next as Section);
  };

  return (
    <Shell
      className="manage"
      menuExtra={props.menuExtra}
      groups={groups}
      active={section}
      onOpen={open}
      mode={props.onCashDesk && { current: "manage", onSwitch: props.onCashDesk }}
      displayName={props.displayName}
      roleLabel={props.roleLabel}
      balances={props.balances}
      onRetryBalances={props.onRetryBalances}
      onLeave={props.onLeave}
      leaveButton={props.leaveButton}
    >
      {props.notices}
      <div hidden={section !== "journal"}>
        {/* The admin's one journal: the owner's view, with the admin's right to correct and delete any entry. */}
        <Journal mode="viewer" login={admin} isAdmin={admin !== undefined} onSessionExpired={onSessionExpired} onRefresh={onRefresh} onBalances={onRefresh} />
      </div>
      <div hidden={section !== "totals"}>
        {opened.has("totals") && <Totals onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "totals"} />}
      </div>
      <div hidden={section !== "reconciliations"}>
        {opened.has("reconciliations") && (
          <ReconciliationsList onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "reconciliations"} />
        )}
      </div>
      <div hidden={section !== "clients"}>
        {opened.has("clients") && <ClientsAdmin canEdit={admin !== undefined} onSessionExpired={onSessionExpired} active={section === "clients"} />}
      </div>
      <div hidden={section !== "categories"}>
        {opened.has("categories") && <CategoriesAdmin onSessionExpired={onSessionExpired} active={section === "categories"} />}
      </div>
      {admin !== undefined && (
        <div hidden={section !== "users"}>
          {opened.has("users") && <UsersAdmin me={admin} onSessionExpired={onSessionExpired} active={section === "users"} />}
        </div>
      )}
    </Shell>
  );
}
