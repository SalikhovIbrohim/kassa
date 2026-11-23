import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { clientLabel, fetchClientCodes, fetchClients, type Client } from "./api";
import { debtWords } from "./cargo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** An entry needs a client code; a filter does not. */
  required?: boolean;
  /** The name stands inside the empty field instead of above it (the entry forms). */
  inside?: boolean;
  /**
   * Told which client of the directory the field names, once it names one exactly (by the code, or as the list writes
   * them), and null when it names none: the form of the cargo takes the price of the client from it.
   */
  onClient?: (client: Client | null) => void;
  /** Say under the field what the client owes, where the business keeps trips (elsewhere a client has no debt to say). */
  debt?: boolean;
};

/** The client that what is typed names exactly: «132», «132 Иброхим», and with the letter left out, «707» for А707. */
function namedClient(typed: string, clients: readonly Client[]): Client | null {
  const text = typed.trim().toLowerCase();
  if (text === "") return null;
  const bare = (code: string) => code.toLowerCase().replace(/^[aа]\s*-?\s*/, "");
  return clients.find((client) => clientLabel(client).toLowerCase() === text || bare(client.code) === bare(text)) ?? null;
}

/** A narrow screen: there the keyboard takes half of it, and the field goes up to leave the suggestions room. */
const onPhone = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches;

/**
 * The client code input. The clients of the directory are offered under the field as the code is typed («А70» → «А707
 * Карим»); while the directory is empty, the codes typed before are. The list is drawn by the page (not the browser's),
 * a few lines high, so it never covers the form.
 */
export function ClientCodeField({ value, onChange, required = true, inside = false, onClient, debt = false }: Props) {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // The client of the directory that the field names now, if it names one.
  const [named, setNamed] = useState<Client | null>(null);
  const tellClient = useRef(onClient);
  tellClient.current = onClient;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      const typed = value.trim();
      let found: string[];
      let client: Client | null = null;
      try {
        const clients = await fetchClients(typed, { limit: 8 });
        client = namedClient(typed, clients);
        // An empty answer to an empty search means no directory yet: the codes of the journal then.
        found = clients.length === 0 && typed === "" ? await fetchClientCodes("") : clients.map(clientLabel);
      } catch {
        // The form of the cargo has no codes of the journal to fall back on: nothing to offer, then.
        found = await fetchClientCodes(typed).catch(() => []);
      }
      if (current) {
        setSuggestions(found);
        setActive(-1);
        setNamed(client);
        tellClient.current?.(client);
      }
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [value]);

  // Nothing to offer once the field holds exactly what the list would give.
  const shown = open && !(suggestions.length === 1 && suggestions[0] === value) ? suggestions : [];

  function pick(choice: string) {
    onChange(choice);
    setOpen(false);
    setActive(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (shown.length === 0) return setOpen(true);
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + shown.length) % shown.length);
    } else if (event.key === "Enter" && active >= 0 && shown[active] !== undefined) {
      // The highlighted client is chosen; the form is sent by the next Enter.
      event.preventDefault();
      pick(shown[active]!);
    } else if (event.key === "Escape" && shown.length > 0) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={wrapper} className="relative scroll-mt-24">
      <Label>
        {inside ? <span className="sr-only">Код клиента</span> : "Код клиента"}
        <Input
          name="clientCode"
          placeholder={inside ? "Код клиента" : undefined}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 && shown.length > 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          required={required}
          maxLength={64}
          value={value}
          onFocus={() => {
            setOpen(true);
            // On a phone the keyboard comes up: the field goes to the top so the suggestions show under it.
            if (onPhone()) setTimeout(() => wrapper.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={keyDown}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
        />
      </Label>
      <ul
        id={listId}
        role="listbox"
        aria-label="Клиенты"
        hidden={shown.length === 0}
        className="absolute inset-x-0 top-full z-40 mt-1 max-h-[min(15rem,40dvh)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {shown.map((choice, index) => (
          <li
            key={choice}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            className={cn(
              "flex min-h-11 cursor-pointer items-center rounded-sm px-3 text-base select-none",
              index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground",
            )}
            // Pressed, not clicked: the field must not lose the focus (and close the list) before the choice is taken.
            onMouseDown={(event) => {
              event.preventDefault();
              pick(choice);
            }}
          >
            {choice}
          </li>
        ))}
      </ul>
      {debt && named && named.debtMinor !== undefined && (
        <p
          className={cn(
            "mt-1.5 px-1 text-sm font-medium",
            debtWords(named.debtMinor).tone === "debt" ? "text-destructive" : debtWords(named.debtMinor).tone === "ahead" ? "text-success" : "text-muted-foreground",
          )}
          data-client-debt={named.code}
        >
          {named.name || named.code}: {debtWords(named.debtMinor).text}
        </p>
      )}
    </div>
  );
}
