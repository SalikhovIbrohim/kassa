import { cva, type VariantProps } from "class-variance-authority";

/**
 * A message in a box: what was saved, what went wrong, what waits on the phone. The elements that use it keep their own
 * tag and role (a paragraph in a live region, an alert), so only the look comes from here.
 */
export const alertVariants = cva("m-0 rounded-lg border px-3.5 py-3 text-base [overflow-wrap:anywhere]", {
  variants: {
    variant: {
      info: "border-border bg-card text-foreground",
      success: "border-green-200 bg-green-50 text-green-800",
      warning: "border-amber-200 bg-amber-50 text-amber-800",
      destructive: "border-red-200 bg-red-50 text-red-800",
    },
  },
  defaultVariants: { variant: "info" },
});

export type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;
