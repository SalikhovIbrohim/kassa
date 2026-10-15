import { useEffect, useId, useState } from "react";
import { clientLabel, createClient, fetchClientCodes, fetchClients, NetworkError, SessionExpiredError } from "./api";
import { CLIENT_WHY_NOT, NewClient } from "./ClientsAdmin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** An entry needs a client code; a filter does not. */
  required?: boolean;
  /** The name stands inside the empty field instead of above it (the entry forms). */
  inside?: boolean;
  /** The admin and the head cashier add a client who is not in the directory yet, right from the form. */
  canAdd?: boolean;
  onSessionExpired?: () => void;
};

/**
 * The client code input. The clients of the directory are offered as the code is typed («А70» → «А707 Карим»); while the
 * directory is empty, the codes typed before are.
 */
export function ClientCodeField({ value, onChange, required = true, inside = false, canAdd = false, onSessionExpired }: Props) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function create(input: { code: string; name: string; phone?: string }) {
    setBusy(true);
    try {
      const result = await createClient(input);
      if (result.ok) {
        onChange(result.client ? clientLabel(result.client) : input.code);
        return true;
      }
      if (result.reason === "session-expired") onSessionExpired?.();
      setError(CLIENT_WHY_NOT[result.reason]);
      return false;
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired?.();
      setError(caught instanceof NetworkError ? "Нет связи с сервером. Попробуйте ещё раз, когда она появится." : CLIENT_WHY_NOT["server-error"]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const field = (
    <Label className={canAdd ? "min-w-0 flex-1" : undefined}>
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
  if (!canAdd) return field;
  return (
    <div className="flex items-end gap-2">
      {field}
      <NewClient busy={busy} error={error} onOpen={() => setError(null)} onCreate={create} label="+ Новый клиент" startCode={value} />
    </div>
  );
}
