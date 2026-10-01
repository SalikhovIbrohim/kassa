import { useImperativeHandle, useRef, type ChangeEvent, type InputHTMLAttributes, type Ref } from "react";

/** Digits and the decimal separator are what counts when the caret is put back after the text is regrouped. */
const isSignificant = (char: string) => /[\d,.]/.test(char);

/**
 * Regroups what a person has typed as an amount: thousands are separated by a space ("500000" becomes
 * "500 000"), the decimal separator is a comma, and there are at most two decimals. Anything else typed
 * is dropped. The result is still read by parseAmountInput, which ignores the spaces.
 */
export function formatAmountText(raw: string): string {
  let whole = "";
  let fraction = "";
  let hasSeparator = false;
  for (const char of raw) {
    if (char >= "0" && char <= "9") {
      if (hasSeparator) {
        if (fraction.length < 2) fraction += char;
      } else if (whole.length < 10) {
        whole += char;
      }
    } else if ((char === "," || char === ".") && !hasSeparator) {
      hasSeparator = true;
    }
  }
  if (whole === "" && hasSeparator) whole = "0";
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, " ");
  return hasSeparator ? `${grouped},${fraction}` : grouped;
}

/** The caret position in `formatted` that has `after` digits and separators to its right. */
export function caretPosition(formatted: string, after: number): number {
  let position = formatted.length;
  let remaining = after;
  while (remaining > 0 && position > 0) {
    position -= 1;
    if (isSignificant(formatted[position]!)) remaining -= 1;
  }
  return position;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode"> & {
  value: string;
  onChange: (text: string) => void;
  ref?: Ref<HTMLInputElement>;
};

/**
 * An amount field that separates the thousands as the cashier types, so a long sum can be read at a glance
 * ("500 000", not "500000"). The text it hands back is already grouped.
 */
export function AmountInput({ value, onChange, ref, ...rest }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);

  function change(event: ChangeEvent<HTMLInputElement>) {
    const field = event.target;
    const typed = field.value;
    const start = field.selectionStart ?? typed.length;
    const after = [...typed.slice(start)].filter(isSignificant).length;
    const formatted = formatAmountText(typed);
    // Set here, not left to the re-render: a controlled field that is rewritten after the event loses its caret.
    field.value = formatted;
    const caret = caretPosition(formatted, after);
    field.setSelectionRange(caret, caret);
    onChange(formatted);
  }

  return (
    <input
      {...rest}
      ref={input}
      type="text"
      inputMode="decimal"
      value={formatAmountText(value)}
      onChange={change}
    />
  );
}
