import { cn } from "@/lib/utils";

type Option<T extends string> = { value: T; label: string };

/**
 * The segment of the prototype for a choice of two or three (the theme, the cash desk): a grey capsule, the chosen one
 * filled black (white in the dark theme). A group of buttons, the chosen one pressed.
 */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly Option<T>[];
  size?: "sm" | "md";
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
            "min-w-0 flex-1 truncate rounded-full px-3 font-semibold whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-200",
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
