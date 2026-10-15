import { CITY_LABEL, type City } from "./api";
import { Select } from "@/components/ui/select";

const CITIES = Object.keys(CITY_LABEL) as City[];
const OPTIONS = [{ value: "", label: "Везде" }, ...CITIES.map((city) => ({ value: city, label: CITY_LABEL[city] }))];

/** Везде, Андижан or Москва: where a category or a person belongs, for the reports and 1C. */
export function CitySelect({
  value,
  onChange,
  ...props
}: {
  value: City | null | undefined;
  onChange: (city: City | null) => void;
  name?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return <Select {...props} value={value ?? ""} onChange={(next) => onChange((next || null) as City | null)} options={OPTIONS} />;
}
