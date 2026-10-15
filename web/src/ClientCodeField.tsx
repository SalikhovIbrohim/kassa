import { useEffect, useId, useState } from "react";
import { clientLabel, fetchClientCodes, fetchClients } from "./api";
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

/**
 * The client code input. The clients of the directory are offered as the code is typed («А70» → «А707 Карим»); while the
 * directory is empty, the codes typed before are.
 */
export function ClientCodeField({ value, onChange, required = true, inside = false }: Props) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      const typed = value.trim();
      let found: string[];
      try {
        const clients = await fetchClients(typed, { limit: 8 });
        // An empty answer to an empty search means no directory yet: the codes of the journal then.
        found = clients.length === 0 && typed === "" ? await fetchClientCodes("") : clients.map(clientLabel);
      } catch {
        found = await fetchClientCodes(typed);
      }
      if (current) setSuggestions(found);
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
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
