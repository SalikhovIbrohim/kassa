import * as React from "react";
import { cn } from "@/lib/utils";

/** The look of a text field, also for the fields that are not this component (the amount field formats as it is typed). */
export const inputClassName =
  "h-12 w-full min-w-0 rounded-md border border-input bg-card px-3.5 text-base text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />;
}

export { Input };
