import type { Category } from "./api";

type Props = {
  categories: Category[];
  /** The chosen category's code, or null while none is chosen. */
  value: string | null;
  onChange: (code: string) => void;
};

/** Big buttons, one per category: the whole list is on screen, one tap picks. */
export function CategoryPicker({ categories, value, onChange }: Props) {
  return (
    <fieldset className="choices categories">
      <legend>На что ушли деньги</legend>
      {categories.map((item) => (
        <label key={item.code} className={item.code === value ? "choice chosen" : "choice"}>
          <input
            type="radio"
            name="category"
            value={item.code}
            checked={item.code === value}
            onChange={() => onChange(item.code)}
          />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}
