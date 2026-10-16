import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** An option of a `Select`; `value` "" stands for "none" (all cities, any author), as it did in the browser's list. */
export type SelectOption = { value: string; label: string; disabled?: boolean; /** A heading the option stands under (options of one group come together). */ group?: string };

/** Radix keeps "" for "nothing chosen": the option meaning "none" travels under this name instead. */
const EMPTY = "__empty__";

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  name?: string;
  required?: boolean;
  disabled?: boolean;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

/**
 * A drop-down list drawn by the page, in the look of the other fields. It opens under the field (above it when there is
 * no room) and is never taller than about half the screen, so the form stays in sight.
 */
function Select({ value, onChange, options, name, required, disabled, placeholder, className, "aria-label": ariaLabel }: Props) {
  const known = options.some((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      // "" (not undefined) when the value is none of the options: the list goes back to its placeholder instead of
      // keeping, uncontrolled, the line chosen last.
      value={known ? value || EMPTY : ""}
      onValueChange={(next) => onChange(next === EMPTY ? "" : next)}
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        data-name={name}
        aria-label={ariaLabel}
        className={cn(
          "flex h-12 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card pr-3.5 pl-3.5 text-left text-base font-normal text-foreground shadow-xs transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value placeholder={placeholder ?? "Выберите…"} />
        </span>
        <SelectPrimitive.Icon asChild>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 shrink-0 text-muted-foreground"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(var(--radix-select-content-available-height),50dvh)] w-[var(--radix-select-trigger-width)] min-w-40 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option, index) => (
              <React.Fragment key={option.value || EMPTY}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{option.group}</div>
              )}
              <SelectPrimitive.Item
                value={option.value || EMPTY}
                disabled={option.disabled}
                data-value={option.value}
                className="relative flex min-h-11 cursor-default items-center rounded-sm py-2 pr-8 pl-3 text-base outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator aria-hidden="true" className="absolute right-2.5 text-primary">✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
              </React.Fragment>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
