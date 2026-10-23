import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * The button, as in shadcn/ui, in the capsule of the prototype: the main button black (white in the dark theme) with a
 * light edge on top, 48 pixels high (52 for the one action of a form), the others grey glass. It gives a little under
 * the finger.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-[background-color,color,transform,opacity] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[0_8px_20px_rgba(10,12,16,0.16),inset_0_1px_0_var(--primary-highlight)] hover:bg-primary/90",
        destructive: "bg-destructive text-white shadow-[0_8px_20px_rgba(10,12,16,0.12)] hover:bg-destructive/90 dark:text-[#0e0f12]",
        outline: "border border-input-edge bg-secondary text-foreground hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-12 px-5 text-base",
        sm: "h-10 px-4 text-sm",
        lg: "h-[52px] px-6 text-[17px]",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
