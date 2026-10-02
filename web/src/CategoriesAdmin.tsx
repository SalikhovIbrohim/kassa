import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  changeCategory,
  createCategory,
  fetchCategories,
  NetworkError,
  SessionExpiredError,
  type Category,
  type CategoryChangeResult,
  type CategoryKind,
} from "./api";

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
        <button type="button" className="secondary small" onClick={load}>
          Обновить
        </button>
      </div>
      <p className="hint">
        Эти списки видят кассиры в формах. Убранная категория уходит в архив: старые записи её помнят, а в новых её уже не выбрать.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {all === null && <p className="hint">Загружаем…</p>}
      {all === undefined && (
        <>
          <p className="error" role="alert">
            Не удалось загрузить списки. Проверьте связь и попробуйте ещё раз.
          </p>
          <button type="button" className="secondary" onClick={load}>
            Повторить
          </button>
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
            onCreate={(label, requiresClient) => apply(() => createCategory(kind, label, requiresClient))}
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
  onChange: (code: string, change: { label?: string; requiresClient?: boolean; archived?: boolean; move?: "up" | "down" }) => Promise<boolean>;
  onCreate: (label: string, requiresClient: boolean) => Promise<boolean>;
};

function CategoryList({ kind, items, busy, editing, onEdit, onChange, onCreate }: ListProps) {
  const [label, setLabel] = useState("");
  const [requiresClient, setRequiresClient] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (label.trim() === "") return;
    if (await onCreate(label.trim(), requiresClient)) {
      setLabel("");
      setRequiresClient(false);
    }
  }

  return (
    <section className="category-list" aria-label={`Категории: ${TITLE[kind].toLowerCase()}`} data-kind={kind}>
      <h3>{TITLE[kind]}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={item.code} className={item.archived ? "category-row archived" : "category-row"} data-category={item.code}>
            {editing === item.code ? (
              <EditCategory
                item={item}
                busy={busy}
                onCancel={() => onEdit(null)}
                onSave={async (change) => {
                  if (await onChange(item.code, change)) onEdit(null);
                }}
              />
            ) : (
              <>
                <span className="category-name">
                  {item.label}
                  {item.requiresClient && <span className="badge">нужен код клиента</span>}
                  {item.archived && <span className="badge deleted">в архиве</span>}
                </span>
                <span className="category-actions">
                  <button type="button" className="secondary small" disabled={busy || index === 0} aria-label={`Выше: ${item.label}`} onClick={() => onChange(item.code, { move: "up" })}>
                    ↑
                  </button>
                  <button type="button" className="secondary small" disabled={busy || index === items.length - 1} aria-label={`Ниже: ${item.label}`} onClick={() => onChange(item.code, { move: "down" })}>
                    ↓
                  </button>
                  <button type="button" className="secondary small" disabled={busy} aria-label={`Изменить: ${item.label}`} onClick={() => onEdit(item.code)}>
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy}
                    aria-label={`${item.archived ? "Вернуть" : "В архив"}: ${item.label}`}
                    onClick={() => onChange(item.code, { archived: !item.archived })}
                  >
                    {item.archived ? "Вернуть" : "В архив"}
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <form className="category-add" onSubmit={add} aria-label={`Новая категория: ${TITLE[kind].toLowerCase()}`}>
        <label>
          Новая категория
          <input name="label" type="text" autoComplete="off" maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" name="requiresClient" checked={requiresClient} onChange={(event) => setRequiresClient(event.target.checked)} />
          Нужен код клиента
        </label>
        <button type="submit" disabled={busy || label.trim() === ""}>
          Добавить
        </button>
      </form>
    </section>
  );
}

function EditCategory({
  item,
  busy,
  onCancel,
  onSave,
}: {
  item: Category;
  busy: boolean;
  onCancel: () => void;
  onSave: (change: { label?: string; requiresClient?: boolean }) => Promise<void>;
}) {
  const [label, setLabel] = useState(item.label);
  const [requiresClient, setRequiresClient] = useState(item.requiresClient);

  function save(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    if (name === "") return;
    void onSave({
      ...(name === item.label ? {} : { label: name }),
      ...(requiresClient === item.requiresClient ? {} : { requiresClient }),
    });
  }

  return (
    <form className="category-edit" onSubmit={save} aria-label={`Изменить категорию ${item.label}`}>
      <label>
        Название
        <input name="label" type="text" autoComplete="off" maxLength={60} autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" name="requiresClient" checked={requiresClient} onChange={(event) => setRequiresClient(event.target.checked)} />
        Нужен код клиента
      </label>
      <div className="queue-actions">
        <button type="submit" disabled={busy || label.trim() === ""}>
          Сохранить
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
