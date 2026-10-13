import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The browser's own drop-down list, dressed like the other fields. On a phone it opens the system's picker, which is
 * quicker to use than a list drawn by the page.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span data-slot="native-select-wrapper" className="relative grid">
      <select
        data-slot="native-select"
        className={cn(
          "h-12 w-full min-w-0 appearance-none rounded-md border border-input bg-card pr-10 pl-3.5 text-base font-normal text-foreground shadow-xs transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

export { NativeSelect };
