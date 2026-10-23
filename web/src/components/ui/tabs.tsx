import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />;
}

/** The row of tabs, a segment of the prototype: a grey capsule, the chosen tab filled black (white in the dark theme). Give it `grid grid-cols-N` to share the width. */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex w-full items-center justify-center gap-0.5 rounded-full border border-input-edge bg-muted p-[3px] text-muted-foreground", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-[38px] flex-1 cursor-pointer items-center justify-center rounded-full px-3 text-[15px] font-semibold whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_2px_6px_rgba(10,12,16,0.16)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The content of a tab. The screens here keep every tab alive and only hide the ones that are not chosen (what was typed
 * into a form is still there when the person comes back), so they pass `forceMount`, which leaves the hiding to the class.
 */
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none data-[state=inactive]:hidden", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
