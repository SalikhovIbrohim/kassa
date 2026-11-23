import { cn } from "@/lib/utils";

type Option<T extends string> = { value: T; label: string };

/**
 * The segment of the prototype for a choice of two or three (the theme, the cash desk): a grey capsule, the chosen one
 * filled black (white in the dark theme). A group of buttons, the chosen one pressed. The options share the width
 * alike; with `fit="content"` each takes what its word needs, so that four of them (every desk and «Все») fit a phone.
 */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  size = "md",
  fit = "equal",
  className,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly Option<T>[];
  size?: "sm" | "md";
  fit?: "equal" | "content";
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex gap-0.5 rounded-full border border-input-edge bg-muted p-[3px]", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={cn(
            "min-w-0 truncate rounded-full font-semibold whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-200",
            fit === "content" ? "flex-auto px-2" : "flex-1 px-3",
            size === "sm" ? "h-7 text-[12.5px]" : "h-[34px] text-[13.5px]",
            option.value === value && "bg-primary text-primary-foreground shadow-[0_2px_6px_rgba(10,12,16,0.16)]",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
