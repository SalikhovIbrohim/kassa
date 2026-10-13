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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  return (
    <section className="categories-admin" aria-label="Категории" aria-busy={busy}>
      <div className="journal-head">
        <h2>Категории</h2>
        <Button type="button" variant="outline" size="sm" onClick={load}>
          Обновить
        </Button>
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

      {all &&
        (["income", "expense"] as const).map((kind) => (
          <CategoryList
            key={kind}
            kind={kind}
            items={all.filter((item) => item.kind === kind)}
            busy={busy}
            editing={editing}
            onEdit={setEditing}
            onChange={(code, change) => apply(() => changeCategory(code, change))}
            onCreate={(label, flags) => apply(() => createCategory(kind, label, flags))}
          />
        ))}
    </section>
  );
}

type ListProps = {
  kind: CategoryKind;
  items: Category[];
  busy: boolean;
  editing: string | null;
  onEdit: (code: string | null) => void;
  onChange: (
    code: string,
    change: { label?: string; requiresClient?: boolean; requiresTrip?: boolean; requiresCounterparty?: boolean; requiresEmployee?: boolean; notifyGroup?: boolean; archived?: boolean; move?: "up" | "down"; position?: number },
  ) => Promise<boolean>;
  onCreate: (label: string, flags: CategoryFlags) => Promise<boolean>;
};

function CategoryList({ kind, items, busy, editing, onEdit, onChange, onCreate }: ListProps) {
  const [label, setLabel] = useState("");
  const [requiresClient, setRequiresClient] = useState(false);
  const [requiresTrip, setRequiresTrip] = useState(false);
  const [requiresCounterparty, setRequiresCounterparty] = useState(false);
  const [requiresEmployee, setRequiresEmployee] = useState(false);
  const [notifyGroup, setNotifyGroup] = useState(true);
  // Dragging with the mouse: which row is held, and where it would land (before the row of that index; the length is the end).
  const [dragged, setDragged] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  function dropAt(at: number) {
    if (dragged === null) return;
    const from = dragged;
    setDragged(null);
    setTarget(null);
    // The place among the others, the dragged one taken out: what the server counts from.
    const position = at > from ? at - 1 : at;
    if (position !== from) void onChange(items[from]!.code, { position });
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (label.trim() === "") return;
    if (await onCreate(label.trim(), { requiresClient, requiresTrip, requiresCounterparty, requiresEmployee, notifyGroup })) {
      setLabel("");
      setRequiresClient(false);
      setRequiresTrip(false);
      setRequiresCounterparty(false);
      setRequiresEmployee(false);
      setNotifyGroup(true);
    }
  }

  return (
    <section className="category-list rounded-xl border bg-card shadow-sm" aria-label={`Категории: ${TITLE[kind].toLowerCase()}`} data-kind={kind}>
      <h3>{TITLE[kind]}</h3>
      <ul>
        {items.map((item, index) => (
          <li
            key={item.code}
            className={cn(
              item.archived ? "category-row archived" : "category-row",
              dragged === index && "opacity-40",
              target === index && dragged !== null && "shadow-[inset_0_2px_0_var(--primary)]",
              target === items.length && index === items.length - 1 && dragged !== null && "shadow-[inset_0_-2px_0_var(--primary)]",
            )}
            data-category={item.code}
            draggable={!busy && editing === null}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.code);
              setDragged(index);
            }}
            onDragOver={(event) => {
              if (dragged === null) return;
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setTarget(event.clientY < box.top + box.height / 2 ? index : index + 1);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (target !== null) dropAt(target);
            }}
            onDragEnd={() => {
              setDragged(null);
              setTarget(null);
            }}
          >
            {editing === item.code ? (
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
            ) : (
              <div className="flex items-center gap-2">
                <span aria-hidden="true" title="Перетащите, чтобы поменять порядок" className="hidden cursor-grab text-lg leading-none text-muted-foreground select-none md:inline">
                  ⠿
                </span>
                <span className="category-name flex min-w-0 flex-1 flex-wrap items-center gap-1.5 font-semibold">
                  {item.label}
                  {item.requiresClient && <Badge variant="secondary" className="text-xs font-medium">нужен код клиента</Badge>}
                  {item.requiresTrip && <Badge variant="secondary" className="text-xs font-medium">нужен рейс</Badge>}
                  {item.requiresCounterparty && <Badge variant="secondary" className="text-xs font-medium">нужен контрагент</Badge>}
                  {item.requiresEmployee && <Badge variant="secondary" className="text-xs font-medium">нужен сотрудник</Badge>}
                  {item.notifyGroup && <Badge variant="secondary" className="text-xs font-medium">в группу Telegram</Badge>}
                  {item.archived && <Badge variant="destructive" className="text-xs font-medium">в архиве</Badge>}
                </span>
                <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" disabled={busy || index === 0} aria-label={`Выше: ${item.label}`} onClick={() => onChange(item.code, { move: "up" })}>
                  ↑
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" disabled={busy || index === items.length - 1} aria-label={`Ниже: ${item.label}`} onClick={() => onChange(item.code, { move: "down" })}>
                  ↓
                </Button>
                <Button type="button" variant="outline" size="icon" className="size-9" disabled={busy} aria-label={`Изменить: ${item.label}`} title="Изменить" onClick={() => onEdit(item.code)}>
                  <PencilIcon />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form className="category-add" onSubmit={add} aria-label={`Новая категория: ${TITLE[kind].toLowerCase()}`}>
        <Label>
          Новая категория
          <Input name="label" type="text" autoComplete="off" maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} />
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
        <Button type="submit" disabled={busy || label.trim() === ""}>
          Добавить
        </Button>
      </form>
    </section>
  );
}

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
  onSave: (change: { label?: string } & Partial<CategoryFlags>) => Promise<void>;
  /** Archives the category, or brings it back from the archive. */
  onArchive: () => Promise<void>;
}) {
  const [label, setLabel] = useState(item.label);
  const [requiresClient, setRequiresClient] = useState(item.requiresClient);
  const [requiresTrip, setRequiresTrip] = useState(item.requiresTrip);
  const [requiresCounterparty, setRequiresCounterparty] = useState(item.requiresCounterparty);
  const [requiresEmployee, setRequiresEmployee] = useState(item.requiresEmployee);
  const [notifyGroup, setNotifyGroup] = useState(item.notifyGroup);

  function save(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    if (name === "") return;
    void onSave({
      ...(name === item.label ? {} : { label: name }),
      ...(requiresClient === item.requiresClient ? {} : { requiresClient }),
      ...(requiresTrip === item.requiresTrip ? {} : { requiresTrip }),
      ...(requiresCounterparty === item.requiresCounterparty ? {} : { requiresCounterparty }),
      ...(requiresEmployee === item.requiresEmployee ? {} : { requiresEmployee }),
      ...(notifyGroup === item.notifyGroup ? {} : { notifyGroup }),
    });
  }

  return (
    <form className="category-edit" onSubmit={save} aria-label={`Изменить категорию ${item.label}`}>
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
      <div className="queue-actions">
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

/** A pencil, the sign of "change this". */
function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}
