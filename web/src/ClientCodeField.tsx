import { useEffect, useId, useState } from "react";
import { fetchClientCodes } from "./api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** An entry needs a client code; a filter does not. */
  required?: boolean;
  /** The name stands inside the empty field instead of above it (the entry forms). */
  inside?: boolean;
};

/** The client code input, with codes typed before offered as suggestions. */
export function ClientCodeField({ value, onChange, required = true, inside = false }: Props) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchClientCodes(value.trim()).then(setSuggestions);
    }, 150);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <Label>
      {inside ? <span className="sr-only">Код клиента</span> : "Код клиента"}
      <Input
        name="clientCode"
        placeholder={inside ? "Код клиента" : undefined}
        type="text"
        list={listId}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        required={required}
        maxLength={64}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {suggestions.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
    </Label>
  );
}
