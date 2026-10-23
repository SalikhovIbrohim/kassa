import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The look of a text field, also for the fields that are not this component (the amount field formats as it is typed): a
 * grey glass 50 pixels high, its edge seen, the text 16 pixels (less, and iOS zooms in).
 */
export const inputClassName =
  "h-[50px] w-full min-w-0 rounded-md border border-input-edge bg-input px-4 text-base font-normal text-foreground transition-[border-color,box-shadow] outline-none placeholder:text-faint-foreground focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-foreground/10 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />;
}

export { Input };
