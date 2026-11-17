import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { changeClient, createClient, fetchClientDirectory, importClients, NetworkError, SessionExpiredError, type Client, type ClientCodes, type ClientResult } from "./api";
import { PencilIcon } from "@/components/icons";
import { alertVariants } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label, LabelNote } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { debtWords, formatDebtInput, formatPrice, formatUsd, parseDebtInput, parsePriceInput } from "./cargo";
import { clientsOfCsv, clientsWithDebtsOfCsv } from "./clients-csv";
import { useWarehouses } from "./warehouses";

type Props = {
  /** The admin changes clients and loads lists; the owner only looks. */
  canEdit: boolean;
  onSessionExpired: () => void;
  active?: boolean;
};

const CLIENT_WHY_NOT: Record<Extract<ClientResult, { ok: false }>["reason"], string> = {
  "session-expired": "Нужно войти заново.",
  forbidden: "Клиентов ведёт админ.",
  "not-found": "Такого клиента уже нет. Нажмите «Обновить».",
  exists: "Клиент с таким кодом уже есть: код у каждого клиента свой.",
  "bad-code": "Код клиента: буква А и цифры, например А707 или А34-2.",
  rejected: "Проверьте поля: что-то заполнено неверно.",
  "server-error": "Не получилось сохранить. Попробуйте ещё раз.",
};

/** What is said of a code where the codes are digits alone; the words above are of the codes with the letter. */
const BAD_DIGITS_CODE = "Код клиента: только цифры, например 707 или 34-2.";

const failure = (caught: unknown) => (caught instanceof NetworkError ? "Нет связи с сервером. Попробуйте ещё раз, когда она появится." : CLIENT_WHY_NOT["server-error"]);

/**
 * The clients, one to a code: a search, «+ Новый», the pencil of a row for the name, the phone, the note, and to switch a
 * client off (a client is never deleted: the entries that name them keep saying who). The admin also loads a whole list.
 */
export function ClientsAdmin({ canEdit, onSessionExpired, active = true }: Props) {
  // null: loading, undefined: did not load.
  const [clients, setClients] = useState<Client[] | null | undefined>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // How a code is written in this business: the server says it with the list.
  const [codes, setCodes] = useState<ClientCodes>("letter");
  const digits = codes === "digits";
  // Where the business keeps trips, a client has a price for a kilogram and a debt, and the list says them.
  const { enabled: keepsTrips } = useWarehouses();
  const [debtorsOnly, setDebtorsOnly] = useState(false);

  const load = useCallback(() => {
    fetchClientDirectory("", { all: true }).then(
      (directory) => {
        setClients(directory.clients);
        setCodes(directory.codes);
      },
      (caught: unknown) => {
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setClients((current) => current ?? undefined);
      },
    );
  }, [onSessionExpired]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const shown = useMemo(() => {
    const typed = search.trim().toLowerCase().replace(/^a/, "а");
    if (!clients) return clients;
    return clients.filter(
      (client) =>
        (!debtorsOnly || (client.debtMinor ?? 0) > 0) &&
        (typed === "" || client.code.toLowerCase().startsWith(typed) || client.name.toLowerCase().includes(typed) || (client.phone ?? "").includes(typed)),
    );
  }, [clients, search, debtorsOnly]);
  // What all the clients owe together, and what was paid ahead: two sums, never one netted against the other.
  const owed = useMemo(() => (clients ?? []).reduce((sum, client) => sum + Math.max(client.debtMinor ?? 0, 0), 0), [clients]);
  const ahead = useMemo(() => (clients ?? []).reduce((sum, client) => sum + Math.max(-(client.debtMinor ?? 0), 0), 0), [clients]);

  async function apply(work: () => Promise<ClientResult>, success: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await work();
      if (result.ok) {
        setDone(success);
        setEditing(null);
        load();
        return true;
      }
      if (result.reason === "session-expired") onSessionExpired();
      else setError(result.reason === "bad-code" && digits ? BAD_DIGITS_CODE : CLIENT_WHY_NOT[result.reason]);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
    return false;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Клиенты" aria-busy={busy}>
      <div className="journal-head">
        <h2>Клиенты</h2>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <NewClient
              busy={busy}
              error={error}
              onOpen={() => setError(null)}
              onCreate={(input) => apply(() => createClient(input), `Добавлен клиент ${input.code}${input.name ? ` ${input.name}` : ""}.`)}
              codes={codes}
              keepsTrips={keepsTrips}
            />
          )}
          {canEdit && <ImportClients codes={codes} keepsTrips={keepsTrips} onDone={(text) => (setDone(text), load())} onSessionExpired={onSessionExpired} />}
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </div>
      <p className="hint">
        У каждого клиента свой код ({digits ? "707, 34-2" : "А707, А34-2"}), имена могут повторяться. В приходе клиента выбирают из этого списка. Клиента не удаляют, а отключают: старые записи
        продолжают его называть.
        {keepsTrips && " Долг клиента это его грузы в прибывших рейсах минус его оплаты в кассе (и то, что он был должен на старте)."}
      </p>

      <Label>
        <span className="sr-only">Поиск</span>
        <Input type="search" placeholder="Поиск: код, имя или телефон" value={search} onChange={(event) => setSearch(event.target.value)} />
      </Label>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}
      {done && <p className={cn(alertVariants({ variant: "success" }), "success")}>{done}</p>}
      {clients === null && <p className="hint">Загружаем…</p>}
      {clients === undefined && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить список. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={load}>
            Повторить
          </Button>
        </>
      )}

      {shown && (
        <>
          <p className="hint" data-count>
            {search.trim() || debtorsOnly ? `Найдено: ${shown.length} из ${clients!.length}` : `Всего клиентов: ${shown.length}`}
          </p>
          {keepsTrips && (
            <div className="glass-card flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg px-4 py-3" data-debts>
              <span>
                Должны всего: <strong className="tabular-nums text-destructive">{formatUsd(owed)}</strong>
              </span>
              {ahead > 0 && (
                <span>
                  Предоплаты: <strong className="tabular-nums text-success">{formatUsd(ahead)}</strong>
                </span>
              )}
              <Button type="button" variant={debtorsOnly ? "default" : "outline"} size="sm" className="ml-auto" aria-pressed={debtorsOnly} onClick={() => setDebtorsOnly((only) => !only)}>
                Только должники
              </Button>
            </div>
          )}
          <ul className="glass-card divide-y overflow-hidden rounded-[26px]">
            {shown.map((client) => (
              <li key={client.code} className={cn("flex flex-col gap-3 px-3 py-2 transition-colors", editing !== client.code && "hover:bg-muted/60")} data-client={client.code}>
                {editing === client.code ? (
                  <EditClient
                    client={client}
                    keepsTrips={keepsTrips}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(change) => apply(() => changeClient(client.code, change), "Сохранено.")}
                    onToggle={() =>
                      void apply(() => changeClient(client.code, { active: !client.active }), client.active ? `${client.code} отключён.` : `${client.code} снова в списке.`)
                    }
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 font-semibold tabular-nums">{client.code}</span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className={cn("font-medium", !client.active && "text-muted-foreground line-through")}>{client.name || "без имени"}</span>
                      {client.phone && <span className="text-sm text-muted-foreground">{client.phone}</span>}
                      {client.note && <span className="text-sm text-muted-foreground">{client.note}</span>}
                      {keepsTrips && client.priceMilli !== undefined && client.priceMilli !== null && (
                        <span className="text-sm text-muted-foreground tabular-nums">{formatPrice(client.priceMilli)} $/кг</span>
                      )}
                      {!client.active && (
                        <Badge variant="destructive" className="text-xs font-medium">
                          отключён
                        </Badge>
                      )}
                    </span>
                    {keepsTrips && client.debtMinor !== undefined && client.debtMinor !== 0 && (
                      <span className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", client.debtMinor > 0 ? "text-destructive" : "text-success")} data-debt>
                        {debtWords(client.debtMinor).text}
                      </span>
                    )}
                    {canEdit && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-9"
                        disabled={busy}
                        aria-label={`Изменить: ${client.code}`}
                        title="Изменить"
                        onClick={() => {
                          setError(null);
                          setEditing(client.code);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Change = { name?: string; phone?: string | null; note?: string | null; priceMilli?: number | null; openingDebtMinor?: number };

/**
 * The name, the phone and the note of one client; the code stays (the entries and 1C know them by it). Where the
 * business keeps trips, also what a kilogram costs the client and what they owed at the start.
 */
function EditClient({
  client,
  keepsTrips,
  busy,
  onCancel,
  onSave,
  onToggle,
}: {
  client: Client;
  keepsTrips: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (change: Change) => Promise<boolean>;
  onToggle: () => void;
}) {
  const [name, setName] = useState(client.name);
  const [phone, setPhone] = useState(client.phone ?? "");
  const [note, setNote] = useState(client.note ?? "");
  const [price, setPrice] = useState(client.priceMilli === undefined || client.priceMilli === null ? "" : formatPrice(client.priceMilli));
  const [openingDebt, setOpeningDebt] = useState(formatDebtInput(client.openingDebtMinor ?? 0));
  const [problem, setProblem] = useState<string | null>(null);

  function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const priceMilli = price.trim() === "" ? null : parsePriceInput(price);
    const openingDebtMinor = parseDebtInput(openingDebt);
    if (keepsTrips && price.trim() !== "" && priceMilli === null) return setProblem("Цена за кг: число, например 1,5 или 1,55.");
    if (keepsTrips && openingDebtMinor === null) return setProblem("Начальный долг: сумма в долларах, например 1200,50; предоплата со знаком минус.");
    const change: Change = {
      ...(name.trim() === client.name ? {} : { name: name.trim() }),
      ...(phone.trim() === (client.phone ?? "") ? {} : { phone: phone.trim() || null }),
      ...(note.trim() === (client.note ?? "") ? {} : { note: note.trim() || null }),
      ...(keepsTrips && priceMilli !== (client.priceMilli ?? null) ? { priceMilli } : {}),
      ...(keepsTrips && openingDebtMinor !== null && openingDebtMinor !== (client.openingDebtMinor ?? 0) ? { openingDebtMinor } : {}),
    };
    if (Object.keys(change).length === 0) onCancel();
    else void onSave(change);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={save} aria-label={`Изменить ${client.code}`}>
      <p className="font-semibold">{client.code}</p>
      <Label>
        Имя
        <Input name="name" autoComplete="off" maxLength={100} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </Label>
      <Label>
        Телефон
        <Input name="phone" type="tel" autoComplete="off" maxLength={100} value={phone} onChange={(event) => setPhone(event.target.value)} />
      </Label>
      <Label>
        Заметка
        <Input name="note" autoComplete="off" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      </Label>
      {keepsTrips && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Label>
              <span>
                Цена за кг <LabelNote>$</LabelNote>
              </span>
              <Input name="price" inputMode="decimal" autoComplete="off" maxLength={9} placeholder="1,5" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Label>
            <Label>
              <span>
                Начальный долг <LabelNote>$</LabelNote>
              </span>
              <Input name="openingDebt" inputMode="decimal" autoComplete="off" maxLength={14} value={openingDebt} onChange={(event) => setOpeningDebt(event.target.value)} />
            </Label>
          </div>
          <p className="text-sm text-muted-foreground" data-debt-parts>
            Начальный долг это сколько клиент был должен, когда рейсы начали вести здесь (предоплата со знаком минус). Сейчас: начислено по прибывшим рейсам{" "}
            <span className="tabular-nums">{formatUsd(client.chargedMinor ?? 0)}</span>, оплачено в кассе <span className="tabular-nums">{formatUsd(client.paidMinor ?? 0)}</span>,{" "}
            <strong>{debtWords(client.debtMinor ?? 0).text}</strong>.
          </p>
        </>
      )}
      {problem && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {problem}
        </p>
      )}
      <div className="queue-actions">
        <Button type="submit" disabled={busy}>
          Сохранить
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Отмена
        </Button>
        <div className="ml-auto">
          <Button type="button" variant={client.active ? "outline" : "default"} disabled={busy} onClick={onToggle}>
            {client.active ? "Отключить" : "Включить"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** «+ Новый»: a window with the code, the name, the phone of a new client. */
function NewClient({
  busy,
  error,
  onOpen,
  onCreate,
  codes,
  keepsTrips,
}: {
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onCreate: (input: { code: string; name: string; phone?: string; priceMilli?: number }) => Promise<boolean>;
  codes: ClientCodes;
  keepsTrips: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [price, setPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setProblem(null);
    const priceMilli = price.trim() === "" ? null : parsePriceInput(price);
    if (keepsTrips && price.trim() !== "" && priceMilli === null) return setProblem("Цена за кг: число, например 1,5 или 1,55.");
    if (await onCreate({ code: code.trim(), name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(keepsTrips && priceMilli !== null ? { priceMilli } : {}) })) {
      setCode("");
      setName("");
      setPhone("");
      setPrice("");
      setOpen(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          + Новый
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Новый клиент</DialogTitle>
        <DialogDescription className="sr-only">Код, имя и телефон нового клиента.</DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={add} aria-label="Новый клиент">
          <Label>
            <span>
              Код <LabelNote>{codes === "digits" ? "(только цифры: 707, 34-2)" : "(А и цифры: А707, А34-2)"}</LabelNote>
            </span>
            <Input name="code" autoComplete="off" autoCapitalize="characters" maxLength={20} required autoFocus value={code} onChange={(event) => setCode(event.target.value)} />
          </Label>
          <Label>
            Имя
            <Input name="name" autoComplete="off" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
          </Label>
          <Label>
            <span>
              Телефон <LabelNote>(по желанию)</LabelNote>
            </span>
            <Input name="phone" type="tel" autoComplete="off" maxLength={100} value={phone} onChange={(event) => setPhone(event.target.value)} />
          </Label>
          {keepsTrips && (
            <Label>
              <span>
                Цена за кг, $ <LabelNote>(подставляется в грузы клиента)</LabelNote>
              </span>
              <Input name="price" inputMode="decimal" autoComplete="off" maxLength={9} placeholder="1,5" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Label>
          )}
          {(problem ?? error) && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              {problem ?? error}
            </p>
          )}
          <div className="queue-actions">
            <Button type="submit" disabled={busy || code.trim() === ""}>
              Добавить
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Отмена
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** «Загрузить список»: the admin picks a CSV file (code, name, phone) and the new codes of it are added. */
function ImportClients({ codes, keepsTrips, onDone, onSessionExpired }: { codes: ClientCodes; keepsTrips: boolean; onDone: (text: string) => void; onSessionExpired: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(file: File) {
    setProblem(null);
    // Where the business keeps trips, a line may also say the price of a kilogram and what the client owed at the start.
    const read = keepsTrips ? clientsWithDebtsOfCsv(await file.text(), codes) : { clients: clientsOfCsv(await file.text(), codes), bad: [] };
    if (read.bad.length > 0) {
      setProblem(`Ничего не загружено: в строках ${read.bad.join(", ")} цена за кг или начальный долг не число. Цена как 1,5, долг как 1200,50 (предоплата со знаком минус).`);
      if (input.current) input.current.value = "";
      return;
    }
    const clients = read.clients;
    if (clients.length === 0) {
      setProblem(`В файле нет ни одного клиента: нужны строки вида «${codes === "digits" ? "707" : "А707"},Карим,телефон».`);
      return;
    }
    setBusy(true);
    try {
      const result = await importClients(clients);
      if (result.ok) onDone(`Загружено: новых клиентов ${result.added}, уже были ${result.skipped}.`);
      else if (result.reason === "session-expired") onSessionExpired();
      else if (result.repeated?.length)
        setProblem(`Ничего не загружено: коды повторяются: ${result.repeated.map((item) => `${item.code} (строки ${item.lines.join(", ")})`).join("; ")}. У каждого клиента свой код.`);
      else if (result.bad?.length) setProblem(`Ничего не загружено: неверные коды в строках ${result.bad.map((item) => `${item.line} (${item.code})`).join(", ")}.`);
      else setProblem(CLIENT_WHY_NOT[result.reason === "forbidden" ? "forbidden" : result.reason === "server-error" ? "server-error" : "rejected"]);
    } catch (caught) {
      setProblem(failure(caught));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label="Файл со списком клиентов"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void load(file);
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Загружаем…" : "Загрузить список"}
      </Button>
      {problem && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error basis-full")} role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
