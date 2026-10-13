import { useEffect, useId, useState } from "react";
import { fetchClientCodes } from "./api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** An entry needs a client code; a filter does not. */
  required?: boolean;
};

/** The client code input, with codes typed before offered as suggestions. */
export function ClientCodeField({ value, onChange, required = true }: Props) {
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
      Код клиента
      <Input
        name="clientCode"
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
