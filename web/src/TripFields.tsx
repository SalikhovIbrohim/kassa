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
};

/** The number of the trip and the counterparty, shown only when the chosen category asks for them (then they must be filled in). */
export function TripFields({
  needsTrip,
  needsCounterparty,
  trip,
  onTripChange,
  counterparty,
  onCounterpartyChange,
}: Props) {
  return (
    <>
      {needsTrip && (
        <Label>
          Номер рейса
          <Input
            name="tripNumber"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
            placeholder="например 194"
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
          Контрагент
          <Input
            name="counterparty"
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
    </>
  );
}
