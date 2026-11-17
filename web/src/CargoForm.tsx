import { useRef, useState, type FormEvent } from "react";
import type { CargoInput, CargoLine, Client, TruckPart } from "./api";
import { cargoAmountMinor, formatCount, formatPrice, formatUsd, formatWeightInput, moscowToday, parseCount, parsePriceInput, parseWeightInput, TRUCK_PART_LABEL } from "./cargo";
import { ClientCodeField } from "./ClientCodeField";
import { useWarehouses } from "./warehouses";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, LabelNote } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Props = {
  /** The warehouses whose cargo this person writes onto this trip. */
  warehouses: readonly string[];
  /** The line being corrected; without it, the form adds a new one. */
  line?: CargoLine;
  busy: boolean;
  /** Why the server did not take the line, said under the fields. */
  error: string | null;
  /** Sends the line; true when it was taken (the form of a new line is then made ready for the next one). */
  onSubmit: (input: CargoInput) => Promise<boolean>;
  onCancel?: () => void;
};

const number = (value: number | null) => (value === null ? "" : String(value));

/** What the waybills of the business are packed in, offered as the field is typed; anything else may be typed too. */
const PACKAGINGS = ["пэ меш", "пп меш", "коробка", "рулон"];

/**
 * A line of the waybill, column for column as the business keeps it in its spreadsheets: where on the truck it lies,
 * the day it was taken in, who receives it and under which code, what it is and how it is packed, how much of it, and
 * what it weighs at what price. The price is the client's own until the person types another, the receiver is the
 * client until another name is typed; the sum is worked out as they type. After a new line is taken, everything about
 * the client and the place stays for the next line, and the goods are emptied.
 */
export function CargoForm({ warehouses, line, busy, error, onSubmit, onCancel }: Props) {
  const { labelOf } = useWarehouses();
  const [warehouse, setWarehouse] = useState(line?.warehouse ?? warehouses[0] ?? "");
  const [truckPart, setTruckPart] = useState<TruckPart | "">(line ? (line.truckPart ?? "") : "head");
  const [acceptedDay, setAcceptedDay] = useState(line ? (line.acceptedDay ?? "") : moscowToday());
  const [clientCode, setClientCode] = useState(line ? (line.clientName ? `${line.clientCode} ${line.clientName}` : line.clientCode) : "");
  const [receiver, setReceiver] = useState(line?.receiver ?? "");
  const [receiverPhone, setReceiverPhone] = useState(line?.receiverPhone ?? "");
  const [sender, setSender] = useState(line?.sender ?? "");
  const [item, setItem] = useState(line?.item ?? "");
  const [brand, setBrand] = useState(line?.brand ?? "");
  const [size, setSize] = useState(line?.size ?? "");
  const [bags, setBags] = useState(number(line?.bags ?? null));
  const [perBag, setPerBag] = useState(number(line?.perBag ?? null));
  const [packaging, setPackaging] = useState(line?.packaging ?? "");
  const [pieces, setPieces] = useState(number(line?.pieces ?? null));
  const [weight, setWeight] = useState(line ? formatWeightInput(line.weightG) : "");
  const [price, setPrice] = useState(line ? formatPrice(line.priceMilli) : "");
  // The client the price and the receiver in the form are of. Another client brings their own; the same client again
  // (the code typed anew, a line opened to be corrected) changes nothing the person has in the form.
  const namedCode = useRef<string | null>(line?.clientCode ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const brandInput = useRef<HTMLInputElement>(null);

  const weightG = parseWeightInput(weight);
  const priceMilli = price.trim() === "" ? null : parsePriceInput(price);
  const amountMinor = weightG !== null && priceMilli !== null ? cargoAmountMinor(weightG, priceMilli) : null;
  // The pieces in all, when the person gave the places and what is in one and left the total to the form.
  const bagsCount = parseCount(bags, 1_000_000);
  const perBagCount = parseCount(perBag, 1_000_000);
  const piecesOfBags = typeof bagsCount === "number" && typeof perBagCount === "number" ? bagsCount * perBagCount : null;

  function clientNamed(client: Client | null) {
    if (!client || client.code === namedCode.current) return;
    namedCode.current = client.code;
    // The price of a kilogram is the client's own, unless the line says another.
    if (client.priceMilli !== undefined && client.priceMilli !== null) setPrice(formatPrice(client.priceMilli));
    // The receiver is the client, unless the waybill names somebody else under the client's code.
    setReceiver(client.name);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setProblem(null);
    if (!warehouse) return setProblem("Выберите склад погрузки.");
    if (clientCode.trim() === "") return setProblem("Введите код клиента.");
    if (weightG === null) return setProblem("Введите общий вес в килограммах, например 1075 или 547,02.");
    if (price.trim() !== "" && priceMilli === null) return setProblem("Цена за кг: число, например 1,4 или 1,45.");
    const piecesCount = pieces.trim() === "" ? piecesOfBags : parseCount(pieces);
    if (bagsCount === undefined || perBagCount === undefined || piecesCount === undefined) return setProblem("Места и штуки: целые числа.");

    const taken = await onSubmit({
      warehouse,
      truckPart: truckPart || null,
      acceptedDay: acceptedDay || null,
      clientCode: clientCode.trim(),
      receiver: receiver.trim() || null,
      receiverPhone: receiverPhone.trim() || null,
      sender: sender.trim() || null,
      item: item.trim() || null,
      brand: brand.trim() || null,
      size: size.trim() || null,
      bags: bagsCount,
      perBag: perBagCount,
      packaging: packaging.trim() || null,
      pieces: piecesCount,
      weightG,
      // Without a price the server takes the client's own.
      ...(priceMilli === null ? {} : { priceMilli }),
    });
    if (taken && !line) {
      // The next line is most often of the same client, on the same part of the truck: only the goods are emptied.
      setItem("");
      setBrand("");
      setSize("");
      setBags("");
      setPerBag("");
      setPieces("");
      setWeight("");
      brandInput.current?.focus();
    }
  }

  const said = problem ?? error;
  // content-start: a field stays under its name when a neighbour grows (the debt of the client said under the code).
  const small = "grid content-start gap-1.5 text-sm font-semibold";

  return (
    <form className="grid gap-3" onSubmit={submit} aria-label={line ? "Изменить груз" : "Добавить груз"}>
      <div className="grid grid-cols-2 gap-3 min-[720px]:grid-cols-3 min-[1200px]:grid-cols-6">
        <Label className={small}>
          Склад погрузки
          {warehouses.length > 1 ? (
            <Select name="warehouse" value={warehouse} onChange={setWarehouse} options={warehouses.map((id) => ({ value: id, label: labelOf(id) }))} />
          ) : (
            <Input name="warehouse" value={labelOf(warehouse)} readOnly disabled />
          )}
        </Label>
        <Label className={small}>
          Место в фуре
          <Select
            name="truckPart"
            value={truckPart}
            onChange={(next) => setTruckPart(next as TruckPart | "")}
            options={[
              { value: "head", label: TRUCK_PART_LABEL.head },
              { value: "trailer", label: TRUCK_PART_LABEL.trailer },
              { value: "", label: "Не указано" },
            ]}
          />
        </Label>
        <Label className={small}>
          Дата приёма
          <Input name="acceptedDay" type="date" value={acceptedDay} onChange={(event) => setAcceptedDay(event.target.value)} />
        </Label>
        <div className={cn(small, "[&_label]:gap-1.5 [&_label]:text-sm")}>
          <ClientCodeField value={clientCode} onChange={setClientCode} onClient={clientNamed} debt />
        </div>
        <Label className={small}>
          Получатель
          <Input
            name="receiver"
            autoComplete="off"
            maxLength={100}
            placeholder="имя клиента"
            value={receiver}
            onChange={(event) => setReceiver(event.target.value)}
          />
        </Label>
        <Label className={small}>
          Телефон
          <Input name="receiverPhone" type="tel" autoComplete="off" maxLength={100} value={receiverPhone} onChange={(event) => setReceiverPhone(event.target.value)} />
        </Label>
      </div>

      <div className="grid grid-cols-2 gap-3 min-[720px]:grid-cols-4 min-[1200px]:grid-cols-8">
        <Label className={small}>
          Бренд
          <Input ref={brandInput} name="brand" autoComplete="off" maxLength={100} value={brand} onChange={(event) => setBrand(event.target.value)} />
        </Label>
        <Label className={cn(small, "min-[1200px]:col-span-2")}>
          Наименование
          <Input name="item" autoComplete="off" maxLength={200} placeholder="Футболка мужская" value={item} onChange={(event) => setItem(event.target.value)} />
        </Label>
        <Label className={small}>
          Размер
          <Input name="size" autoComplete="off" maxLength={50} placeholder="48-58" value={size} onChange={(event) => setSize(event.target.value)} />
        </Label>
        <Label className={small}>
          Места
          <Input name="bags" inputMode="numeric" autoComplete="off" maxLength={9} value={bags} onChange={(event) => setBags(event.target.value)} />
        </Label>
        <Label className={small}>
          В мешке, шт
          <Input name="perBag" inputMode="numeric" autoComplete="off" maxLength={9} value={perBag} onChange={(event) => setPerBag(event.target.value)} />
        </Label>
        <Label className={small}>
          Вид упаковки
          <Input name="packaging" autoComplete="off" maxLength={50} list="cargo-packagings" placeholder="пэ меш" value={packaging} onChange={(event) => setPackaging(event.target.value)} />
          <datalist id="cargo-packagings">
            {PACKAGINGS.map((kind) => (
              <option key={kind} value={kind} />
            ))}
          </datalist>
        </Label>
        <Label className={small}>
          Кол-во, шт
          <Input
            name="pieces"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            // What the places come to, until the person types another number.
            placeholder={piecesOfBags === null ? undefined : formatCount(piecesOfBags)}
            value={pieces}
            onChange={(event) => setPieces(event.target.value)}
          />
        </Label>
      </div>

      <div className="grid grid-cols-2 items-end gap-3 min-[720px]:flex min-[720px]:flex-wrap">
        <Label className={cn(small, "min-[720px]:w-36")}>
          Общий вес, кг
          <Input name="weight" inputMode="decimal" autoComplete="off" maxLength={12} required value={weight} onChange={(event) => setWeight(event.target.value)} />
        </Label>
        <Label className={cn(small, "min-[720px]:w-32")}>
          <span>
            Цена <LabelNote>$ за кг</LabelNote>
          </span>
          <Input
            name="price"
            inputMode="decimal"
            autoComplete="off"
            maxLength={9}
            placeholder="клиента"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </Label>
        <Label className={cn(small, "col-span-2 min-[720px]:w-48")}>
          Отправитель
          <Input name="sender" autoComplete="off" maxLength={100} value={sender} onChange={(event) => setSender(event.target.value)} />
        </Label>
        <div className={cn(small, "col-span-2 min-[720px]:w-40")}>
          Сумма
          <output name="amount" className="flex h-[50px] items-center rounded-md border border-input-edge bg-muted px-4 text-base font-semibold tabular-nums">
            {amountMinor === null ? "—" : formatUsd(amountMinor)}
          </output>
        </div>
        <div className="col-span-2 flex gap-2 min-[720px]:ml-auto">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Отмена
            </Button>
          )}
          <Button type="submit" className="flex-1" disabled={busy}>
            {busy ? "Записываем…" : line ? "Сохранить" : "Добавить строку"}
          </Button>
        </div>
      </div>

      {said && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {said}
        </p>
      )}
    </form>
  );
}
