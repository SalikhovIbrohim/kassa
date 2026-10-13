import * as React from "react";
import { cn } from "@/lib/utils";

/** A label that holds its field: the words above, the field below, so the field is named by them. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("grid gap-2 text-base font-semibold select-none", className)} {...props} />;
}

/** "(необязательно)" and the like, after the words of a label. */
function LabelNote({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("font-normal text-muted-foreground", className)} {...props} />;
}

export { Label, LabelNote };
