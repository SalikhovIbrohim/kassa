import * as React from "react";
import { cn } from "@/lib/utils";

/** The browser's own check box, in the main color and big enough for a finger. */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return <input type="checkbox" data-slot="checkbox" className={cn("size-5 shrink-0 cursor-pointer accent-primary", className)} {...props} />;
}

export { Checkbox };
