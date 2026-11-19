import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./sections";
import { cn } from "@/lib/utils";

/**
 * The buttons of a page that stand in the row of its name, at the right: «Обновить», the filters, the period. The
 * frame (Shell.tsx) has the row, one on a phone and one on a computer; a page puts its buttons there with
 * `PageActions`, and only while it is the page on show.
 */
export const PageActionsContext = createContext<{ phone: HTMLElement | null; computer: HTMLElement | null }>({ phone: null, computer: null });

export function PageActions({ active = true, children }: { active?: boolean; children: ReactNode }) {
  const slots = useContext(PageActionsContext);
  if (!active) return null;
  return (
    <>
      {slots.phone && createPortal(children, slots.phone)}
      {slots.computer && createPortal(children, slots.computer)}
    </>
  );
}

/** A round button with an icon and no words on it; `label` is what it is called. `count`: a small number on its corner. */
export function IconButton({ icon, label, count, pressed, onClick, className }: { icon: IconName; label: string; count?: number; pressed?: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "relative grid size-10 flex-none place-items-center rounded-full border bg-card text-foreground shadow-sm transition-colors hover:bg-muted active:scale-95",
        pressed && "bg-primary text-primary-foreground hover:bg-primary",
        className,
      )}
      onClick={onClick}
    >
      <Icon name={icon} size={19} />
      {count !== undefined && count > 0 && (
        <span className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[11px] leading-none font-bold text-primary-foreground" data-count>
          {count}
        </span>
      )}
    </button>
  );
}
