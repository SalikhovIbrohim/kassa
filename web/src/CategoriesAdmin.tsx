import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  changeCategory,
  createCategory,
  fetchCategories,
  NetworkError,
  SessionExpiredError,
  type Category,
  type CategoryChangeResult,
  type CategoryFlags,
  type CategoryKind,
} from "./api";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { PencilIcon } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

type Props = {
  onSessionExpired: () => void;
  /** The screen is on show: it asks for the lists again when it comes back, in case another device changed them. */
  active?: boolean;
};

const TITLE: Record<CategoryKind, string> = { income: "Приход", expense: "Расход" };

const WHY_NOT: Record<Extract<CategoryChangeResult, { ok: false }>["reason"], string> = {
  "session-expired": "Нужно войти заново.",
  forbidden: "Менять списки может только владелец.",
  "not-found": "Такой категории уже нет. Нажмите «Обновить».",
  exists: "Такая категория уже есть в этом списке.",
  "last-category": "Нельзя убрать последнюю категорию списка: в форме должен остаться выбор.",
  "category-used": "По этой категории уже есть записи: тип менять нельзя, иначе старые приходы стали бы расходами. Заведите новую категорию нужного типа.",
  "kind-locked": "У этой категории тип не меняется: оплата от клиента уходит в 1С, а передача владельцу считается отдельно.",
  rejected: "Проверьте название: оно не должно быть пустым или длиннее 60 знаков.",
  "server-error": "Не получилось сохранить. Попробуйте ещё раз.",
};

/**
 * The owner's lists of categories of incomes and expenses: add, rename, say whether an entry of the category
 * names a client, move up and down, archive (a category is never deleted: old entries keep reading it).
 */
export function CategoriesAdmin({ onSessionExpired, active = true }: Props) {
  // null: loading, undefined: did not load.
  const [all, setAll] = useState<Category[] | null | undefined>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchCategories().then(setAll, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setAll((current) => current ?? undefined);
    });
  }, [onSessionExpired]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  /** Runs one change, and shows the lists as the server now has them. True when it went through. */
  async function apply(work: () => Promise<CategoryChangeResult>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result.ok) {
        setAll(result.all);
        return true;
      }
      if (result.reason === "session-expired") onSessionExpired();
      else setError(WHY_NOT[result.reason]);
    } catch (caught) {
      setError(caught instanceof NetworkError ? "Нет связи с сервером. Попробуйте ещё раз, когда она появится." : WHY_NOT["server-error"]);
    } finally {
      setBusy(false);
    }
    return false;
  }

  /**
   * One change of a category. A tick or a type shows at once (the table answers the hand, not the network), and the
   * list comes back as the server has it; if the server said no, the list is read again.
   */
  async function change(code: string, what: Parameters<typeof changeCategory>[1]): Promise<boolean> {
    const { move, position, label, archived, ...shown } = what;
    if (Object.keys(shown).length > 0 && move === undefined && position === undefined && label === undefined && archived === undefined) {
      setAll((current) => current?.map((item) => (item.code === code ? { ...item, ...shown } : item)));
    }
    const done = await apply(() => changeCategory(code, what));
    if (!done) load();
    return done;
  }

  return (
    <section className="categories-admin" aria-label="Категории" aria-busy={busy}>
      <div className="journal-head">
        <h2>Категории</h2>
        <div className="flex gap-2">
          <NewCategory busy={busy} error={error} onCreate={(kind, label, flags) => apply(() => createCategory(kind, label, flags))} onOpen={() => setError(null)} />
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </div>
      <p className="hint">
        Эти списки видят кассиры в формах. Убранная категория уходит в архив: старые записи её помнят, а в новых её уже не выбрать.
      </p>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}
      {all === null && <p className="hint">Загружаем…</p>}
      {all === undefined && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить списки. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={load}>
            Повторить
          </Button>
        </>
      )}

      {all && <CategoryTable items={all} busy={busy} editing={editing} onEdit={setEditing} onChange={change} />}
    </section>
  );
}

type Change = Parameters<typeof changeCategory>[1];

/** What an entry of the category has to say, one column each: ticked right in the table. */
const FLAGS: Array<{ key: "requiresClient" | "requiresTrip" | "requiresCounterparty" | "requiresEmployee" | "notifyGroup"; title: string; short: string }> = [
  { key: "requiresClient", title: "Нужен код клиента", short: "Код клиента" },
  { key: "requiresTrip", title: "Нужен номер рейса", short: "Рейс" },
  { key: "requiresCounterparty", title: "Нужен контрагент", short: "Контр­агент" },
  { key: "requiresEmployee", title: "Нужен сотрудник", short: "Сотруд­ник" },
  { key: "notifyGroup", title: "Сообщать в группу Telegram", short: "В группу Telegram" },
];

/** A very light tint tells the incomes from the expenses without hurting the eyes. */
const TINT: Record<CategoryKind, string> = {
  income: "bg-emerald-600/[0.045]",
  expense: "bg-rose-600/[0.04]",
};

/** Under the mouse the row darkens a little in its own color, so the eye stays on the line being ticked. */
const HOVER: Record<CategoryKind, string> = {
  income: "transition-colors hover:bg-emerald-600/[0.13]",
  expense: "transition-colors hover:bg-rose-600/[0.12]",
};

/**
 * All the categories in one table, incomes first: the type and what an entry has to say are ticked right in the
 * row, the arrows and the mouse put them in order within their type, the pencil renames or archives.
 */
function CategoryTable({
  items,
  busy,
  editing,
  onEdit,
  onChange,
}: {
  items: Category[];
  busy: boolean;
  editing: string | null;
  onEdit: (code: string | null) => void;
  onChange: (code: string, change: Change) => Promise<boolean>;
}) {
  // Dragging with the mouse, within one type: the row held, and the place it would land (an index in its type's list).
  const [dragged, setDragged] = useState<{ kind: CategoryKind; index: number } | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  function dropAt(list: Category[], at: number) {
    if (dragged === null) return;
    const from = dragged.index;
    setDragged(null);
    setTarget(null);
    // The place among the others, the dragged one taken out: what the server counts from.
    const position = at > from ? at - 1 : at;
    if (position !== from) void onChange(list[from]!.code, { position });
  }

  // The header stays under the page's own header while the table scrolls, so every column keeps its name.
  // (A line drawn with a shadow: a border of a sticky cell does not travel with it.)
  const head = "sticky top-[calc(4rem+1px)] z-[5] bg-muted px-3 py-2.5 text-[13px] leading-tight font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

  return (
    // Scrolled sideways only on a narrow screen: a box that scrolls would keep the header from sticking to the page.
    <div className="rounded-xl border bg-card shadow-sm max-[959px]:overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr>
            <th className={cn(head, "w-8 rounded-tl-xl")} aria-label="Порядок" />
            <th className={cn(head, "text-left")}>Категория</th>
            <th className={cn(head, "w-36 text-left")}>Тип</th>
            {FLAGS.map((flag) => (
              <th key={flag.key} className={cn(head, "w-[92px] text-center")} title={flag.title}>
                {flag.short}
              </th>
            ))}
            <th className={cn(head, "w-[132px] rounded-tr-xl")} aria-label="Действия" />
          </tr>
        </thead>
        {(["income", "expense"] as const).map((kind) => {
          const list = items.filter((item) => item.kind === kind);
          return (
            <tbody key={kind} data-kind={kind} aria-label={`Категории: ${TITLE[kind].toLowerCase()}`}>
              {list.map((item, index) =>
                editing === item.code ? (
                  <tr key={item.code} className={TINT[kind]} data-category={item.code}>
                    <td colSpan={FLAGS.length + 4} className="border-b px-3 py-3">
                      <EditCategory
                        item={item}
                        busy={busy}
                        onCancel={() => onEdit(null)}
                        onSave={async (change) => {
                          if (await onChange(item.code, change)) onEdit(null);
                        }}
                        onArchive={async () => {
                          if (await onChange(item.code, { archived: !item.archived })) onEdit(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={item.code}
                    data-category={item.code}
                    className={cn(
                      "category-row",
                      TINT[kind],
                      HOVER[kind],
                      dragged?.kind === kind && dragged.index === index && "opacity-40",
                      dragged?.kind === kind && target === index && "shadow-[inset_0_2px_0_var(--primary)]",
                      dragged?.kind === kind && target === list.length && index === list.length - 1 && "shadow-[inset_0_-2px_0_var(--primary)]",
                    )}
                    onDragOver={(event) => {
                      if (dragged?.kind !== kind) return;
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      setTarget(event.clientY < box.top + box.height / 2 ? index : index + 1);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (target !== null) dropAt(list, target);
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                      setTarget(null);
                    }}
                  >
                    <td className="border-b pl-3 text-lg leading-none text-muted-foreground select-none">
                      {/* The row is taken by its handle: the rest of it holds fields to click. */}
                      <span
                        aria-hidden="true"
                        title="Перетащите, чтобы поменять порядок"
                        className="inline-block cursor-grab px-1 py-2"
                        draggable={!busy && editing === null}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", item.code);
                          setDragged({ kind, index });
                        }}
                      >
                        ⠿
                      </span>
                    </td>
                    <td className="border-b px-3 py-2">
                      <span className={cn("category-name flex flex-wrap items-center gap-1.5 font-semibold", item.archived && "text-muted-foreground")}>
                        {item.label}
                        {item.archived && (
                          <Badge variant="destructive" className="text-xs font-medium">
                            в архиве
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="border-b px-3 py-2">
                      <NativeSelect
                        aria-label={`Тип: ${item.label}`}
                        className="h-9 bg-card/70 text-sm"
                        value={kind}
                        disabled={busy || item.code === "client_payment" || !item.countsAsCost}
                        onChange={(event) => void onChange(item.code, { kind: event.target.value as CategoryKind })}
                      >
                        <option value="income">Приход</option>
                        <option value="expense">Расход</option>
                      </NativeSelect>
                    </td>
                    {FLAGS.map((flag) => (
                      <td key={flag.key} className="border-b px-3 py-2 text-center">
                        <Checkbox
                          aria-label={`${flag.title}: ${item.label}`}
                          checked={item[flag.key]}
                          disabled={busy}
                          onChange={(event) => void onChange(item.code, { [flag.key]: event.target.checked })}
                        />
                      </td>
                    ))}
                    <td className="border-b px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" disabled={busy || index === 0} aria-label={`Выше: ${item.label}`} onClick={() => onChange(item.code, { move: "up" })}>
                          ↑
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" disabled={busy || index === list.length - 1} aria-label={`Ниже: ${item.label}`} onClick={() => onChange(item.code, { move: "down" })}>
                          ↓
                        </Button>
                        <Button type="button" variant="outline" size="icon" className="size-9" disabled={busy} aria-label={`Изменить: ${item.label}`} title="Изменить" onClick={() => onEdit(item.code)}>
                          <PencilIcon />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** The pencil: the name, and the archive. What an entry has to say is ticked in the table itself. */
function EditCategory({
  item,
  busy,
  onCancel,
  onSave,
  onArchive,
}: {
  item: Category;
  busy: boolean;
  onCancel: () => void;
  onSave: (change: { label?: string }) => Promise<void>;
  /** Archives the category, or brings it back from the archive. */
  onArchive: () => Promise<void>;
}) {
  const [label, setLabel] = useState(item.label);

  function save(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    if (name === "") return;
    if (name === item.label) onCancel();
    else void onSave({ label: name });
  }

  return (
    <form className="category-edit flex flex-wrap items-end gap-3" onSubmit={save} aria-label={`Изменить категорию ${item.label}`}>
      <Label className="min-w-[240px] flex-1">
        Название
        <Input name="label" type="text" autoComplete="off" maxLength={60} autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
      </Label>
      <div className="queue-actions flex-1">
        <Button type="submit" disabled={busy || label.trim() === ""}>
          Сохранить
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Отмена
        </Button>
        <Button type="button" variant={item.archived ? "outline" : "destructive"} className="ml-auto" disabled={busy} onClick={() => void onArchive()}>
          {item.archived ? "Вернуть из архива" : "В архив"}
        </Button>
      </div>
    </form>
  );
}

/** "+ Новая": a window with the kind (income or expense), the name and the ticks of a new category. */
function NewCategory({
  busy,
  error,
  onCreate,
  onOpen,
}: {
  busy: boolean;
  error: string | null;
  onCreate: (kind: CategoryKind, label: string, flags: CategoryFlags) => Promise<boolean>;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [label, setLabel] = useState("");
  const [requiresClient, setRequiresClient] = useState(false);
  const [requiresTrip, setRequiresTrip] = useState(false);
  const [requiresCounterparty, setRequiresCounterparty] = useState(false);
  const [requiresEmployee, setRequiresEmployee] = useState(false);
  const [notifyGroup, setNotifyGroup] = useState(true);

  function reset() {
    setLabel("");
    setRequiresClient(false);
    setRequiresTrip(false);
    setRequiresCounterparty(false);
    setRequiresEmployee(false);
    setNotifyGroup(true);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (label.trim() === "") return;
    if (await onCreate(kind, label.trim(), { requiresClient, requiresTrip, requiresCounterparty, requiresEmployee, notifyGroup })) {
      reset();
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
          + Новая
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Новая категория</DialogTitle>
        <DialogDescription className="sr-only">Приход или расход, название и что должна указать запись этой категории.</DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={add} aria-label="Новая категория">
          <fieldset className="m-0 grid min-w-0 grid-cols-2 gap-2.5 border-0 p-0">
            <legend className="mb-2 p-0 text-base font-semibold">Куда</legend>
            {(["income", "expense"] as const).map((value) => (
              <label
                key={value}
                data-slot="choice"
                className={cn(
                  "relative flex h-11 cursor-pointer items-center justify-center rounded-md border px-3 text-base font-semibold transition-colors has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
                  value === kind ? "border-primary bg-primary text-primary-foreground shadow-xs" : "border-input bg-card text-foreground hover:bg-accent",
                )}
              >
                <input type="radio" name="kind" value={value} checked={value === kind} onChange={() => setKind(value)} data-slot="choice-input" className="absolute size-px opacity-0" />
                {TITLE[value]}
              </label>
            ))}
          </fieldset>
          <Label>
            Название
            <Input name="label" type="text" autoComplete="off" maxLength={60} autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
          </Label>
          <Label className="flex items-center gap-2.5 font-normal">
            <Checkbox name="requiresClient" checked={requiresClient} onChange={(event) => setRequiresClient(event.target.checked)} />
            Нужен код клиента
          </Label>
          <Label className="flex items-center gap-2.5 font-normal">
            <Checkbox name="requiresTrip" checked={requiresTrip} onChange={(event) => setRequiresTrip(event.target.checked)} />
            Нужен номер рейса
          </Label>
          <Label className="flex items-center gap-2.5 font-normal">
            <Checkbox name="requiresCounterparty" checked={requiresCounterparty} onChange={(event) => setRequiresCounterparty(event.target.checked)} />
            Нужен контрагент
          </Label>
          <Label className="flex items-center gap-2.5 font-normal">
            <Checkbox name="requiresEmployee" checked={requiresEmployee} onChange={(event) => setRequiresEmployee(event.target.checked)} />
            Нужен сотрудник
          </Label>
          <Label className="flex items-center gap-2.5 font-normal">
            <Checkbox name="notifyGroup" checked={notifyGroup} onChange={(event) => setNotifyGroup(event.target.checked)} />
            Сообщать в группу Telegram
          </Label>
          {error && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              {error}
            </p>
          )}
          <div className="queue-actions">
            <Button type="submit" disabled={busy || label.trim() === ""}>
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
