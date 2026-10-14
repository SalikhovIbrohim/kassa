import { CITY_LABEL, type City } from "./api";
import { NativeSelect } from "@/components/ui/native-select";

const CITIES = Object.keys(CITY_LABEL) as City[];

/** Везде, Андижан or Москва: where a category or a person belongs, for the reports and 1C. */
export function CitySelect({
  value,
  onChange,
  className,
  ...props
}: { value: City | null | undefined; onChange: (city: City | null) => void; className?: string } & Omit<React.ComponentProps<"select">, "value" | "onChange">) {
  return (
    <NativeSelect {...props} className={className} value={value ?? ""} onChange={(event) => onChange((event.target.value || null) as City | null)}>
      <option value="">Везде</option>
      {CITIES.map((city) => (
        <option key={city} value={city}>
          {CITY_LABEL[city]}
        </option>
      ))}
    </NativeSelect>
  );
}
