import type { City } from "./api";
import { useKassa } from "./kassa";
import { Select } from "@/components/ui/select";

/** Везде, or one of the cities of the business (its cash desks): where a category or a person belongs. */
export function CitySelect({
  value,
  onChange,
  none = "Везде",
  ...props
}: {
  value: City | null | undefined;
  onChange: (city: City | null) => void;
  /** What choosing no city is called. */
  none?: string;
  name?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const { kassas } = useKassa();
  const options = [
    { value: "", label: none },
    // By name, as a list of cities reads.
    ...[...kassas].sort((a, b) => a.label.localeCompare(b.label, "ru")).map((item) => ({ value: item.id, label: item.label })),
    // A city the business does not have any more is still shown as what it is, until another is chosen.
    ...(value && !kassas.some((item) => item.id === value) ? [{ value, label: value }] : []),
  ];
  return <Select {...props} value={value ?? ""} onChange={(next) => onChange((next || null) as City | null)} options={options} />;
}
