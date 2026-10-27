import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { GROUPS, Icon, SECTIONS, type SectionKey } from "./sections";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  /** The sections this person has, in the order of the menu. */
  sections: readonly SectionKey[];
  /** The buttons of the tab bar of a phone (four chosen, then «Настройки»). */
  tabs: readonly SectionKey[];
  active: SectionKey;
  onOpen: (key: SectionKey) => void;
  /** A section opened from «Настройки» on a phone, not on the tab bar: the way back to it. */
  onBack?: () => void;
  /** The forms have no big title: on a phone their name is in the row of Telegram's buttons. */
  compact?: boolean;
  displayName: string;
  roleLabel: string;
  /** The right of the header of a computer: the balances. */
  headerExtra?: ReactNode;
  onLeave: () => void;
  leaveButton?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

/**
 * One frame for every screen, as in the prototype. On a phone the page runs edge to edge (under the bars of Telegram in
 * full screen) and a capsule of glass at the bottom holds five buttons, a lens under the chosen one. On a computer a
 * menu of glass on the left (the sections in groups, who is signed in) and a header with the section, the balances and
 * «Выйти».
 */
export function Shell(props: Props) {
  const { sections, tabs, active, onOpen, onBack, compact = false, children } = props;
  const title = SECTIONS[active].label;
  // The tab under the lens: the section itself, or «Настройки» for a section opened from there.
  const activeTab = tabs.includes(active) ? active : "settings";

  return (
    <div className="min-h-dvh min-[960px]:grid min-[960px]:grid-cols-[264px_minmax(0,1fr)]" data-signed-in data-section={active}>
      <aside className="glass-card sticky top-4 m-4 mr-0 hidden h-[calc(100dvh-2rem)] flex-col overflow-y-auto rounded-xl px-3 py-4 min-[960px]:flex">
        <div className="mb-3 flex items-center gap-2.5 px-2">
          <span aria-hidden="true" className="grid size-10 flex-none place-items-center rounded-[12px] bg-primary text-[19px] font-extrabold text-primary-foreground shadow-[inset_0_1px_0_var(--primary-highlight)]">
            К
          </span>
          <span className="grid leading-tight">
            <h1 className="text-[17px] font-bold">Касса</h1>
            <small className="text-[12px] text-muted-foreground">Книга наличных</small>
          </span>
        </div>
        <nav aria-label="Разделы" className="grid gap-0.5">
          {GROUPS.map((group, index) => {
            const keys = group.keys.filter((key) => sections.includes(key));
            if (keys.length === 0) return null;
            return (
              <div key={group.title ?? index} className="grid gap-0.5">
                {group.title ? (
                  <div className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">{group.title}</div>
                ) : (
                  <div className="h-2" />
                )}
                {keys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-current={key === active ? "page" : undefined}
                    className={cn(
                      "flex h-11 items-center gap-3 rounded-[14px] px-3 text-left text-[15px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      key === active && "bg-primary text-primary-foreground shadow-[inset_0_1px_0_var(--primary-highlight)] hover:bg-primary hover:text-primary-foreground",
                    )}
                    onClick={() => onOpen(key)}
                  >
                    <Icon name={SECTIONS[key].icon as never} size={20} />
                    {SECTIONS[key].label}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center gap-3 border-t px-2 pt-3">
          <span aria-hidden="true" className="grid size-[38px] flex-none place-items-center rounded-full bg-accent text-[13.5px] font-semibold text-muted-foreground">
            {initials(props.displayName)}
          </span>
          {/* The classes "who" and "role" are hooks for the tests of the browser. */}
          <span className="grid min-w-0 leading-tight">
            <span className="who truncate font-semibold">{props.displayName}</span>
            <span className="role truncate text-[12.5px] text-muted-foreground">{props.roleLabel}</span>
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* A computer: the section, the balances, «Выйти». */}
        <header className="sticky top-0 z-10 hidden min-h-16 items-center justify-between gap-4 px-6 pt-4 min-[960px]:flex">
          <h2 className="truncate text-2xl font-bold tracking-tight">{title}</h2>
          <div className="flex items-center gap-3">
            {props.headerExtra}
            <Button ref={props.leaveButton} type="button" variant="outline" size="sm" onClick={props.onLeave}>
              <Icon name="logout" size={18} />
              Выйти
            </Button>
          </div>
        </header>

        {/* A phone: the page under the bars of Telegram (or of the phone), above the tab bar. */}
        <div className="app-page grid min-w-0 content-start gap-4 px-4 min-[960px]:px-6 min-[960px]:pt-4 min-[960px]:pb-8">
          {/* Inside Telegram its own back button takes the place of this one (a variant, not a rule of the components
              layer: the utility "flex" would win over that). */}
          {onBack && (
            <button
              type="button"
              className="phone-back -ml-1 flex w-fit items-center gap-1 text-[15px] font-semibold text-muted-foreground min-[960px]:hidden [.tg-app_&]:hidden"
              onClick={onBack}
            >
              <Icon name="chevronLeft" size={18} stroke={2.2} />
              Настройки
            </button>
          )}
          {!compact && (
            <div className="flex items-center gap-3 min-[960px]:hidden">
              <span aria-hidden="true" className="grid size-10 flex-none place-items-center rounded-[12px] bg-primary text-[19px] font-extrabold text-primary-foreground">
                К
              </span>
              <h2 className="truncate text-[28px] leading-tight font-extrabold tracking-tight">{title}</h2>
            </div>
          )}
          {compact && <h2 className="sr-only min-[960px]:hidden">{title}</h2>}
          {children}
        </div>
      </div>

      <div className="tg-fade" aria-hidden="true" />
      <div className="tg-title" aria-hidden="true">
        {title}
      </div>
      <TabBar tabs={tabs} active={activeTab} onOpen={onOpen} />
    </div>
  );
}

/** A field that brings up the keyboard (not a checkbox, a radio or a button). */
function typesText(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden"].includes(element.type);
}

/**
 * True while the keyboard of a phone is up: a text field has the focus and the screen got shorter. The screen is
 * checked as well because on Android the keyboard can be closed (the back button) while the field keeps the focus.
 */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    let tallest = viewport?.height ?? window.innerHeight;
    let timer: number | undefined;
    const check = () => {
      const height = viewport?.height ?? window.innerHeight;
      tallest = Math.max(tallest, height);
      const shorter = viewport ? height < tallest - 120 : true;
      setUp(typesText(document.activeElement) && shorter);
    };
    // Going from one field to the next is a focusout and a focusin: checked once both have happened, so no flicker.
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 80);
    };
    const turned = () => {
      tallest = 0;
      later();
    };
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    viewport?.addEventListener("resize", later);
    window.addEventListener("resize", later);
    window.addEventListener("orientationchange", turned);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      viewport?.removeEventListener("resize", later);
      window.removeEventListener("resize", later);
      window.removeEventListener("orientationchange", turned);
    };
  }, []);
  return up;
}

/**
 * The tab bar of a phone: a capsule of glass over the bottom of the page, the lens sliding under the chosen button. Not
 * on a computer, which has the menu on the left.
 */
function TabBar({ tabs, active, onOpen }: { tabs: readonly SectionKey[]; active: SectionKey; onOpen: (key: SectionKey) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [lens, setLens] = useState<{ left: number; width: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  // While the keyboard is up the bar steps aside: the field being typed in and the button under it stay in sight.
  const keyboardUp = useKeyboardUp();

  useLayoutEffect(() => {
    const place = () => {
      const button = bar.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
      if (button) setLens({ left: button.offsetLeft, width: button.offsetWidth });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [active, tabs]);

  return (
    <div
      className={cn(
        "tabbar-wrap pointer-events-none fixed inset-x-0 bottom-0 z-30 transition-[translate,opacity,visibility] duration-200 motion-reduce:transition-none min-[960px]:hidden",
        keyboardUp && "invisible translate-y-full opacity-0",
      )}
      data-keyboard-up={keyboardUp || undefined}
    >
      <div
        ref={bar}
        role="tablist"
        aria-label="Основные разделы"
        className={cn("glass-bar pointer-events-auto relative mx-3 flex h-16 rounded-[32px] p-[5px] select-none", pressed && "[&_.lens]:scale-[1.07]")}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
      >
        {lens && (
          <span
            aria-hidden="true"
            className="lens absolute top-[5px] bottom-[5px] left-0 rounded-[27px] transition-[transform,width,scale] duration-500 ease-[cubic-bezier(.34,1.45,.64,1)] motion-reduce:transition-none"
            style={{ width: lens.width, transform: `translateX(${lens.left}px)`, background: "var(--lens)", boxShadow: "inset 0 1px 0 var(--lens-highlight), var(--lens-shadow)" }}
          />
        )}
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            data-tab={key}
            aria-selected={key === active}
            className={cn(
              "relative z-[1] flex min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-[27px] text-[10.5px] font-semibold tracking-[.01em] text-muted-foreground transition-colors",
              key === active && "text-foreground",
            )}
            onClick={() => onOpen(key)}
          >
            <Icon name={SECTIONS[key].icon as never} size={23} />
            <span className="max-w-full truncate px-0.5">{SECTIONS[key].label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
