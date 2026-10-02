import type { Category, CategoryKind } from "./api";

type Props = {
  /** Every category (see `fetchCategories`): null while it loads, undefined when it did not load. */
  list: Category[] | null | undefined;
  kind: CategoryKind;
  label: string;
  /** The chosen category's code, or null while none is chosen. */
  value: string | null;
  onChange: (code: string) => void;
  /** Asks for the list again, when it did not load. */
  onReload: () => void;
  /** The category an entry has already, offered even when the owner has archived it (correcting an old entry). */
  keep?: string | null;
};

/** The categories of one kind as a drop-down list, in the order of the owner's list. */
export function CategoryField({ list, kind, label, value, onChange, onReload, keep = null }: Props) {
  if (list === null) return <p className="hint">Загружаем категории…</p>;
  if (list === undefined) {
    return (
      <div className="categories-missing">
        <p className="error" role="alert">
          Список категорий не загрузился.
        </p>
        <button type="button" className="secondary" onClick={onReload}>
          Повторить
        </button>
      </div>
    );
  }
  const options = list.filter((item) => item.kind === kind && (!item.archived || item.code === keep));
  return (
    <label>
      {label}
      <select name="category" required value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        {value === null && (
          <option value="" disabled>
            Выберите…
          </option>
        )}
        {options.map((item) => (
          <option key={item.code} value={item.code}>
            {item.label}
            {item.archived ? " (в архиве)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
