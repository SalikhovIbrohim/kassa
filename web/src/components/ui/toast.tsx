import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/** What a notice says: done (green dot), waits (amber), or went wrong (red). */
export type ToastKind = "ok" | "warn" | "error";
type Toast = { id: number; text: string; kind: ToastKind };

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/**
 * A short notice in a dark capsule at the top of the screen, gone after a moment, as in the prototype («Записано»).
 * Two at most are shown; the older one leaves first. It only repeats what the screen says in its own place.
 */
export function toast(text: string, kind: ToastKind = "ok") {
  const id = next++;
  toasts = [...toasts, { id, text, kind }].slice(-2);
  changed();
  setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id);
    changed();
  }, 2600);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const DOT: Record<ToastKind, string> = { ok: "bg-success", warn: "bg-warning", error: "bg-destructive" };
const MARK: Record<ToastKind, string> = { ok: "✓", warn: "!", error: "!" };

/** Where the notices appear: once, at the top of the app. */
export function Toaster() {
  const shown = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {shown.map((item) => (
        <div
          key={item.id}
          className="flex max-w-full animate-[toast-in_.45s_cubic-bezier(.34,1.56,.64,1)] items-center gap-2 rounded-full bg-primary py-2.5 pr-4 pl-2.5 text-sm font-semibold text-primary-foreground shadow-[0_10px_30px_rgba(10,12,16,0.25)]"
        >
          <span aria-hidden="true" className={cn("grid size-5 flex-none place-items-center rounded-full text-[12px] text-white", DOT[item.kind])}>
            {MARK[item.kind]}
          </span>
          <span className="truncate">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
