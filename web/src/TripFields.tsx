import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** "194" -> 194; anything that is not a whole number above zero (empty, letters, "19,4") -> null. */
export function parseTripNumber(text: string): number | null {
  const digits = text.trim();
  if (!/^\d{1,9}$/.test(digits)) return null;
  const value = Number(digits);
  return value > 0 ? value : null;
}

type Props = {
  needsTrip: boolean;
  needsCounterparty: boolean;
  trip: string;
  onTripChange: (text: string) => void;
  counterparty: string;
  onCounterpartyChange: (text: string) => void;
  needsEmployee: boolean;
  employee: string;
  onEmployeeChange: (text: string) => void;
  /** The names stand inside the empty fields instead of above them (the entry forms). */
  inside?: boolean;
};

/** The number of the trip, the counterparty and the employee, shown only when the chosen category asks for them (then they must be filled in). */
export function TripFields({
  needsTrip,
  needsCounterparty,
  trip,
  onTripChange,
  counterparty,
  onCounterpartyChange,
  needsEmployee,
  employee,
  onEmployeeChange,
  inside = false,
}: Props) {
  const name = (text: string) => (inside ? <span className="sr-only">{text}</span> : text);
  return (
    <>
      {needsTrip && (
        <Label>
          {name("Номер рейса")}
          <Input
            name="tripNumber"
            placeholder={inside ? "Номер рейса" : undefined}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
            required
            maxLength={9}
            value={trip}
            // Only digits: the number of a trip is a number.
            onChange={(event) =>
              onTripChange(event.target.value.replace(/\D/g, ""))
            }
          />
        </Label>
      )}
      {needsCounterparty && (
        <Label>
          {name("Контрагент")}
          <Input
            name="counterparty"
            placeholder={inside ? "Контрагент" : undefined}
            type="text"
            autoComplete="off"
            enterKeyHint="next"
            required
            maxLength={100}
            value={counterparty}
            onChange={(event) => onCounterpartyChange(event.target.value)}
          />
        </Label>
      )}
      {needsEmployee && (
        <Label>
          {name("Сотрудник")}
          <Input
            name="employee"
            placeholder={inside ? "Сотрудник" : undefined}
            type="text"
            autoComplete="off"
            enterKeyHint="next"
            required
            maxLength={100}
            value={employee}
            onChange={(event) => onEmployeeChange(event.target.value)}
          />
        </Label>
      )}
    </>
  );
}
