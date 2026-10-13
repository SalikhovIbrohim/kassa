import { useState, type ReactNode, type Ref } from "react";
import type { Balance } from "./api";
import type { BalancesState } from "./Balances";
import { CategoriesAdmin } from "./CategoriesAdmin";
import { Journal } from "./Journal";
import { CURRENCIES, CURRENCY_NAME, formatMoney, type Currency } from "./money";
import { ReconciliationsList } from "./ReconciliationsList";
import { Totals } from "./Totals";
import { UsersAdmin } from "./UsersAdmin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Section = "journal" | "totals" | "reconciliations" | "categories" | "users";

const LABEL: Record<Section, string> = {
  journal: "Журнал",
  totals: "Итоги",
  reconciliations: "Сверки",
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
  const [menuOpen, setMenuOpen] = useState(false);

  const groups: Array<{ title: string | null; items: Section[] }> = [
    { title: null, items: ["journal", "totals", "reconciliations"] },
    { title: "Настройки", items: admin === undefined ? ["categories"] : ["categories", "users"] },
  ];

  const open = (next: Section) => {
    setOpened((previous) => new Set(previous).add(next));
    setSection(next);
    setMenuOpen(false);
  };

  const menu = (phone: boolean) => (
    <Menu
      {...props}
      // The menu of a phone lives outside this screen (over the page): it has to close before the cash desk shows.
      onCashDesk={
        props.onCashDesk &&
        (() => {
          setMenuOpen(false);
          props.onCashDesk?.();
        })
      }
      groups={groups}
      section={section}
      onOpen={open}
      phone={phone}
    />
  );

  return (
    <div className="manage min-h-dvh bg-background min-[960px]:grid min-[960px]:grid-cols-[232px_minmax(0,1fr)]" data-signed-in>
      <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r bg-card px-3 py-4 min-[960px]:flex">{menu(false)}</aside>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-[280px] max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 border-r bg-card px-3 py-4">
          <DialogTitle className="sr-only">Меню</DialogTitle>
          <DialogDescription className="sr-only">Разделы Управления</DialogDescription>
          {menu(true)}
        </DialogContent>
      </Dialog>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b bg-card px-4 py-2 min-[960px]:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="icon" className="size-10 text-xl min-[960px]:hidden" aria-label="Меню" onClick={() => setMenuOpen(true)}>
              ☰
            </Button>
            <h2 className="truncate text-xl font-bold">{LABEL[section]}</h2>
          </div>
          <div className="flex items-center gap-5">
            <HeaderBalances balances={props.balances} onRetry={props.onRetryBalances} />
            <span className="hidden h-6 w-px bg-border min-[960px]:block" />
            <Button ref={props.leaveButton} type="button" variant="outline" size="sm" className="hidden min-[960px]:inline-flex" onClick={props.onLeave}>
              Выйти
            </Button>
          </div>
        </header>

        <div className="grid min-w-0 content-start gap-4 px-4 py-5 min-[960px]:px-6">
          {props.notices}
          <div hidden={section !== "journal"}>
            <Journal mode="viewer" onSessionExpired={onSessionExpired} onRefresh={onRefresh} />
          </div>
          <div hidden={section !== "totals"}>
            {opened.has("totals") && <Totals onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "totals"} />}
          </div>
          <div hidden={section !== "reconciliations"}>
            {opened.has("reconciliations") && (
              <ReconciliationsList onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "reconciliations"} />
            )}
          </div>
          <div hidden={section !== "categories"}>
            {opened.has("categories") && <CategoriesAdmin onSessionExpired={onSessionExpired} active={section === "categories"} />}
          </div>
          {admin !== undefined && (
            <div hidden={section !== "users"}>
              {opened.has("users") && <UsersAdmin me={admin} onSessionExpired={onSessionExpired} active={section === "users"} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The left menu: «Касса», the switch back to the cash desk (the admin's), the sections, and who is signed in. */
function Menu({
  groups,
  section,
  onOpen,
  phone,
  displayName,
  roleLabel,
  onCashDesk,
  onLeave,
}: Props & { groups: Array<{ title: string | null; items: Section[] }>; section: Section; onOpen: (section: Section) => void; phone: boolean }) {
  return (
    <>
      <h1 className="mb-3 ml-3 text-[1.6rem] leading-tight font-bold text-primary">Касса</h1>
      {onCashDesk && (
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-[14px] bg-muted p-1" role="group" aria-label="Режим">
          <button type="button" className="min-h-[34px] rounded-[10px] text-[13px] font-semibold text-foreground/80 hover:bg-card/60" onClick={onCashDesk}>
            Касса
          </button>
          <span className="flex min-h-[34px] items-center justify-center rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground shadow-sm" aria-current="true">
            Управление
          </span>
        </div>
      )}
      <nav aria-label="Разделы" className="grid gap-0.5">
        {groups.map((group) => (
          <div key={group.title ?? "main"} className="grid gap-0.5">
            {group.title && <div className="px-3 pt-[18px] pb-1.5 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">{group.title}</div>}
            {group.items.map((item) => (
              <button
                key={item}
                type="button"
                aria-current={item === section ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] px-3 text-left text-sm font-semibold text-foreground/80 hover:bg-muted",
                  phone ? "h-11" : "h-10",
                  item === section && "bg-primary text-primary-foreground shadow-sm hover:bg-primary",
                )}
                onClick={() => onOpen(item)}
              >
                {LABEL[item]}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex items-center justify-between gap-2 border-t p-3">
        <span className="grid gap-1">
          {/* The classes "who" and "role" are hooks for the tests of the browser. */}
          <span className="who font-semibold">{displayName}</span>
          <Badge className="role w-fit">{roleLabel}</Badge>
        </span>
        {phone && (
          <Button type="button" variant="outline" size="sm" onClick={onLeave}>
            Выйти
          </Button>
        )}
      </div>
    </>
  );
}

/** The balances, small, in the header: in a row on a computer, one under the other on a phone. */
function HeaderBalances({ balances, onRetry }: { balances: BalancesState; onRetry: () => void }) {
  if (balances === undefined) {
    return (
      <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onRetry}>
        Остатки: повторить
      </Button>
    );
  }
  const known = Array.isArray(balances) ? (balances as Balance[]) : undefined;
  const shown = (currency: Currency) => {
    const balance = known?.find((item) => item.currency === currency);
    return {
      text: balance ? formatMoney(balance.amountMinor, currency) : balances === "offline" ? "—" : "…",
      negative: !!balance && balance.amountMinor < 0,
    };
  };
  return (
    <section aria-label="Остатки" className="grid text-right leading-tight tabular-nums min-[960px]:flex min-[960px]:items-baseline min-[960px]:gap-5">
      {CURRENCIES.map((currency) => {
        const { text, negative } = shown(currency);
        return (
          <span key={currency} className="flex items-baseline justify-end gap-2" data-currency={currency}>
            <span className="hidden text-[13px] text-muted-foreground min-[960px]:inline">{CURRENCY_NAME[currency]}</span>
            <strong className={cn("text-[13px] font-semibold min-[960px]:text-[17px] min-[960px]:font-bold", negative && "text-destructive")}>{text}</strong>
          </span>
        );
      })}
    </section>
  );
}
