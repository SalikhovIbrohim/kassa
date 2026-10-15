import { useState, type ReactNode, type Ref } from "react";
import type { Balance } from "./api";
import type { BalancesState } from "./Balances";
import { CURRENCY_NAME, formatMoney, type Currency } from "./money";
import { KASSA_CURRENCIES, KASSA_LABEL, KASSAS, useKassa } from "./kassa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ShellGroup = { title: string | null; items: Array<{ key: string; label: string }> };

type Props = {
  /** A class for the screen ("manage", "cash"): what its sections are styled by. */
  className?: string;
  groups: ShellGroup[];
  active: string;
  onOpen: (key: string) => void;
  /** The admin's switch at the top of the menu: which screen this is, and the way to the other one. */
  mode?: { current: "cash" | "manage"; onSwitch: () => void };
  displayName: string;
  roleLabel: string;
  balances: BalancesState;
  onRetryBalances: () => void;
  onLeave: () => void;
  leaveButton?: Ref<HTMLButtonElement>;
  /** Something of the menu itself, over who is signed in (linking Telegram, say). */
  menuExtra?: ReactNode;
  children: ReactNode;
};

/**
 * One frame for every screen, the cash desk and «Управление» alike: on a computer a menu on the left (Касса, the
 * admin's switch, the sections, who is signed in) and a header with the section, the balances and «Выйти»; on a
 * phone the same menu comes out from the left behind ☰, «Выйти» in it, and the header keeps the balances.
 */
export function Shell(props: Props) {
  const { groups, active, onOpen, mode, children } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const { kassa, choosable, setKassa } = useKassa();
  const title = groups.flatMap((group) => group.items).find((item) => item.key === active)?.label ?? "";

  // The menu of a phone lives over the page: it closes before anything else happens.
  const close = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const menu = (phone: boolean) => (
    <>
      <h1 className="mb-3 ml-3 text-[1.6rem] leading-tight font-bold text-primary">Касса</h1>
      {mode && (
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-[14px] bg-muted p-1" role="group" aria-label="Режим">
          {(["cash", "manage"] as const).map((side) =>
            side === mode.current ? (
              <span key={side} className="flex min-h-[34px] items-center justify-center rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground shadow-sm" aria-current="true">
                {side === "cash" ? "Касса" : "Управление"}
              </span>
            ) : (
              <button key={side} type="button" className="min-h-[34px] rounded-[10px] text-[13px] font-semibold text-foreground/80 hover:bg-card/60" onClick={close(mode.onSwitch)}>
                {side === "cash" ? "Касса" : "Управление"}
              </button>
            ),
          )}
        </div>
      )}
      {/* A person of everywhere chooses the cash desk: what the screens show and where the entries go. */}
      {choosable && (
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-[14px] bg-muted p-1" role="group" aria-label="Касса">
          {KASSAS.map((item) =>
            item === kassa ? (
              <span key={item} className="flex min-h-[34px] items-center justify-center rounded-[10px] bg-card text-[13px] font-semibold text-primary shadow-sm" aria-current="true">
                {KASSA_LABEL[item]}
              </span>
            ) : (
              <button key={item} type="button" className="min-h-[34px] rounded-[10px] text-[13px] font-semibold text-foreground/80 hover:bg-card/60" onClick={close(() => setKassa(item))}>
                {KASSA_LABEL[item]}
              </button>
            ),
          )}
        </div>
      )}
      <nav aria-label="Разделы" className="grid gap-0.5">
        {groups.map((group) => (
          <div key={group.title ?? "main"} className="grid gap-0.5">
            {group.title && <div className="px-3 pt-[18px] pb-1.5 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">{group.title}</div>}
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-current={item.key === active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] px-3 text-left text-sm font-semibold text-foreground/80 hover:bg-muted",
                  phone ? "h-11" : "h-10",
                  item.key === active && "bg-primary text-primary-foreground shadow-sm hover:bg-primary",
                )}
                onClick={close(() => onOpen(item.key))}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {props.menuExtra && <div className="mt-auto border-t px-3 pt-3">{props.menuExtra}</div>}
      <div className={cn("flex items-center justify-between gap-2 border-t p-3", !props.menuExtra && "mt-auto", props.menuExtra && "border-t-0")}>
        <span className="grid gap-1">
          {/* The classes "who" and "role" are hooks for the tests of the browser. */}
          <span className="who font-semibold">{props.displayName}</span>
          <Badge className="role w-fit">{props.roleLabel}</Badge>
        </span>
        {phone && (
          <Button type="button" variant="outline" size="sm" onClick={close(props.onLeave)}>
            Выйти
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div className={cn(props.className, "min-h-dvh bg-background min-[960px]:grid min-[960px]:grid-cols-[232px_minmax(0,1fr)]")} data-signed-in>
      <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r bg-card px-3 py-4 min-[960px]:flex">{menu(false)}</aside>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-[280px] max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 border-r bg-card px-3 py-4">
          <DialogTitle className="sr-only">Меню</DialogTitle>
          <DialogDescription className="sr-only">Разделы</DialogDescription>
          {menu(true)}
        </DialogContent>
      </Dialog>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b bg-card px-4 py-2 min-[960px]:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="icon" className="size-10 text-xl min-[960px]:hidden" aria-label="Меню" onClick={() => setMenuOpen(true)}>
              ☰
            </Button>
            <h2 className="truncate text-xl font-bold">{title}</h2>
            {choosable && <Badge className="kassa-name shrink-0">{KASSA_LABEL[kassa]}</Badge>}
          </div>
          <div className="flex items-center gap-5">
            <HeaderBalances balances={props.balances} onRetry={props.onRetryBalances} />
            <span className="hidden h-6 w-px bg-border min-[960px]:block" />
            <Button ref={props.leaveButton} type="button" variant="outline" size="sm" className="hidden min-[960px]:inline-flex" onClick={props.onLeave}>
              Выйти
            </Button>
          </div>
        </header>

        <div className="grid min-w-0 content-start gap-4 px-4 py-5 min-[960px]:px-6">{children}</div>
      </div>
    </div>
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
  const { kassa } = useKassa();
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
      {KASSA_CURRENCIES[kassa].map((currency) => {
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
