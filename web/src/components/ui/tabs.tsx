import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />;
}

/** The row of tabs: a grey bar, the chosen tab filled with the main color. Give it `grid grid-cols-N` to share the width. */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex min-h-12 w-full items-center justify-center gap-1 rounded-xl bg-muted p-1 text-muted-foreground", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-lg px-1 py-1 text-sm font-semibold whitespace-nowrap text-slate-700 transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm",
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
