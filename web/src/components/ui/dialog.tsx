import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useTelegramBackButton } from "@/telegram";

/** How far down a sheet is pulled before letting go closes it. */
const SWIPE_TO_CLOSE_PX = 90;
/** From this width a window is in the middle of the screen, and is not pulled. */
const WINDOW_FROM_PX = 640;

/** While a window is open, Telegram's back button is its own and closes it (see `useTelegramBackButton`). */
function BackCloses({ close }: { close: () => void }) {
  useTelegramBackButton(close);
  return null;
}

/**
 * A sheet of a phone goes away when it is pulled down by its grip or its title, 90 px and more; pulled less, it comes
 * back. Only from the top: with the contents scrolled down the finger scrolls them, as anywhere.
 */
function usePullToClose(close: () => void) {
  const pull = React.useRef<{ id: number; from: number; by: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget;
    if (window.innerWidth >= WINDOW_FROM_PX || sheet.scrollTop > 0) return;
    if (!(event.target as Element).closest("[data-sheet-grab], [data-slot=dialog-title]")) return;
    pull.current = { id: event.pointerId, from: event.clientY, by: 0 };
    try {
      sheet.setPointerCapture(event.pointerId);
    } catch {
      // a pointer that cannot be held: the sheet still follows it while it is over the sheet
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const now = pull.current;
    if (!now || now.id !== event.pointerId) return;
    now.by = Math.max(0, event.clientY - now.from);
    const sheet = event.currentTarget;
    sheet.style.animation = "none";
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${now.by}px)`;
  };
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const now = pull.current;
    if (!now || now.id !== event.pointerId) return;
    pull.current = null;
    const sheet = event.currentTarget;
    if (now.by >= SWIPE_TO_CLOSE_PX) {
      close();
      return;
    }
    sheet.style.transition = "transform .25s cubic-bezier(.2,.9,.25,1)";
    sheet.style.transform = "";
  };
  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * A window. On a phone it is a sheet that comes up from the bottom (with the grip of the prototype), on a computer a
 * window in the middle of the screen. `side="left"` makes it a panel that comes out from the left (the menu ☰).
 */
function DialogContent({
  className,
  children,
  side = "auto",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { side?: "auto" | "left" }) {
  // Closing goes through the window's own «Закрыть», so that whoever opened it hears of it as of any other closing.
  const closer = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => closer.current?.click(), []);
  const pulled = usePullToClose(close);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-[fade-in_.28s_ease-out]"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "glass-sheet fixed z-50 flex flex-col gap-4 overflow-y-auto outline-none",
          side === "left"
            ? "inset-y-0 left-0 data-[state=open]:animate-[drawer-in_.38s_cubic-bezier(.2,.9,.25,1)]"
            : [
                // A phone: a sheet over the bottom of the screen, above the home bar.
                // It ends under the buttons of Telegram (and of the phone), which stay over it and in reach.
                "inset-x-0 bottom-0 max-h-[calc(100dvh-max(3.5rem,var(--app-safe-top)+0.5rem))] rounded-t-[30px] px-4 pt-7 pb-[max(1.25rem,env(safe-area-inset-bottom))]",
                "data-[state=open]:animate-[sheet-in_.42s_cubic-bezier(.2,.9,.25,1)]",
                // A computer: a window in the middle.
                "min-[640px]:inset-x-auto min-[640px]:top-1/2 min-[640px]:bottom-auto min-[640px]:left-1/2 min-[640px]:max-h-[calc(100dvh-2rem)] min-[640px]:w-[calc(100%-2rem)] min-[640px]:max-w-md min-[640px]:-translate-x-1/2 min-[640px]:-translate-y-1/2 min-[640px]:rounded-xl min-[640px]:p-5 min-[640px]:shadow-[0_20px_60px_rgba(10,12,16,0.3)]",
                "min-[640px]:data-[state=open]:animate-[window-in_.3s_cubic-bezier(.34,1.4,.64,1)]",
              ],
          className,
        )}
        {...props}
        {...(side === "auto" ? pulled : {})}
      >
        <BackCloses close={close} />
        {side === "auto" && (
          // The grip, and around it a strip wide enough for a thumb: the sheet is pulled down by it.
          <span aria-hidden="true" data-sheet-grab className="absolute inset-x-0 top-0 h-7 touch-none min-[640px]:hidden">
            <span className="absolute top-2 left-1/2 h-[5px] w-[38px] -translate-x-1/2 rounded-full bg-accent" />
          </span>
        )}
        {children}
        <DialogPrimitive.Close
          ref={closer}
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-full bg-muted text-xl leading-none text-muted-foreground hover:bg-accent"
          aria-label="Закрыть"
        >
          ×
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("touch-none pr-10 text-lg font-bold min-[640px]:touch-auto", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger };
