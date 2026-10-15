import type { Category, CategoryKind } from "./api";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  if (list === null) return <p className="m-0 text-muted-foreground">Загружаем категории…</p>;
  if (list === undefined) {
    return (
      <div className="categories-missing grid gap-2.5">
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Список категорий не загрузился.
        </p>
        <Button type="button" variant="outline" onClick={onReload}>
          Повторить
        </Button>
      </div>
    );
  }
  const options = list.filter((item) => item.kind === kind && ((!item.archived && item.offered !== false) || item.code === keep));
  return (
    <Label>
      {label}
      <Select
        name="category"
        required
        value={value ?? ""}
        onChange={onChange}
        options={options.map((item) => ({ value: item.code, label: `${item.label}${item.archived ? " (в архиве)" : ""}` }))}
      />
    </Label>
  );
}
