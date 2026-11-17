import { useRef, useState, type FormEvent } from "react";
import type { CargoInput, CargoLine, Client } from "./api";
import { cargoAmountMinor, formatCount, formatPrice, formatUsd, formatWeightInput, parseCount, parsePriceInput, parseWeightInput } from "./cargo";
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

/**
 * A line of cargo: where it was loaded, whose it is, what it is, how much of it, and what it weighs at what price. The
 * price is the client's own until the person types another; the sum is worked out as they type. After a new line is
 * taken, the warehouse, the client and the sender stay for the next line of the same client, and the goods are emptied.
 */
export function CargoForm({ warehouses, line, busy, error, onSubmit, onCancel }: Props) {
  const { labelOf } = useWarehouses();
  const [warehouse, setWarehouse] = useState(line?.warehouse ?? warehouses[0] ?? "");
  const [clientCode, setClientCode] = useState(line ? (line.clientName ? `${line.clientCode} ${line.clientName}` : line.clientCode) : "");
  const [sender, setSender] = useState(line?.sender ?? "");
  const [receiverPhone, setReceiverPhone] = useState(line?.receiverPhone ?? "");
  const [item, setItem] = useState(line?.item ?? "");
  const [brand, setBrand] = useState(line?.brand ?? "");
  const [size, setSize] = useState(line?.size ?? "");
  const [bags, setBags] = useState(number(line?.bags ?? null));
  const [perBag, setPerBag] = useState(number(line?.perBag ?? null));
  const [pieces, setPieces] = useState(number(line?.pieces ?? null));
  const [weight, setWeight] = useState(line ? formatWeightInput(line.weightG) : "");
  const [price, setPrice] = useState(line ? formatPrice(line.priceMilli) : "");
  // The price was typed by the person: the price of a client chosen afterwards does not replace it.
  const priceTyped = useRef(line !== undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const itemInput = useRef<HTMLInputElement>(null);

  const weightG = parseWeightInput(weight);
  const priceMilli = price.trim() === "" ? null : parsePriceInput(price);
  const amountMinor = weightG !== null && priceMilli !== null ? cargoAmountMinor(weightG, priceMilli) : null;
  // The pieces in all, when the person gave the bags and what is in a bag and left the total to the form.
  const bagsCount = parseCount(bags, 1_000_000);
  const perBagCount = parseCount(perBag, 1_000_000);
  const piecesOfBags = typeof bagsCount === "number" && typeof perBagCount === "number" ? bagsCount * perBagCount : null;

  function clientNamed(client: Client | null) {
    if (client?.priceMilli !== undefined && client.priceMilli !== null && !priceTyped.current) setPrice(formatPrice(client.priceMilli));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setProblem(null);
    if (!warehouse) return setProblem("Выберите склад погрузки.");
    if (clientCode.trim() === "") return setProblem("Введите код клиента.");
    if (weightG === null) return setProblem("Введите вес в килограммах, например 1075 или 547,02.");
    if (price.trim() !== "" && priceMilli === null) return setProblem("Цена за кг: число, например 1,5 или 1,55.");
    const piecesCount = pieces.trim() === "" ? piecesOfBags : parseCount(pieces);
    if (bagsCount === undefined || perBagCount === undefined || piecesCount === undefined) return setProblem("Мешки и штуки: целые числа.");

    const taken = await onSubmit({
      warehouse,
      clientCode: clientCode.trim(),
      sender: sender.trim() || null,
      receiverPhone: receiverPhone.trim() || null,
      item: item.trim() || null,
      brand: brand.trim() || null,
      size: size.trim() || null,
      bags: bagsCount,
      perBag: perBagCount,
      pieces: piecesCount,
      weightG,
      // Without a price the server takes the client's own.
      ...(priceMilli === null ? {} : { priceMilli }),
    });
    if (taken && !line) {
      // The next line is most often of the same client: only the goods are emptied.
      setItem("");
      setBrand("");
      setSize("");
      setBags("");
      setPerBag("");
      setPieces("");
      setWeight("");
      itemInput.current?.focus();
    }
  }

  const said = problem ?? error;
  // content-start: a field stays under its name when a neighbour grows (the debt of the client said under the code).
  const small = "grid content-start gap-1.5 text-sm font-semibold";

  return (
    <form className="grid gap-3" onSubmit={submit} aria-label={line ? "Изменить груз" : "Добавить груз"}>
      <div className="grid gap-3 min-[720px]:grid-cols-2 min-[1200px]:grid-cols-4">
        <Label className={small}>
          Склад погрузки
          {warehouses.length > 1 ? (
            <Select name="warehouse" value={warehouse} onChange={setWarehouse} options={warehouses.map((id) => ({ value: id, label: labelOf(id) }))} />
          ) : (
            <Input name="warehouse" value={labelOf(warehouse)} readOnly disabled />
          )}
        </Label>
        <div className={cn(small, "[&_label]:gap-1.5 [&_label]:text-sm")}>
          <ClientCodeField value={clientCode} onChange={setClientCode} onClient={clientNamed} debt />
        </div>
        <Label className={small}>
          От кого
          <Input name="sender" autoComplete="off" maxLength={100} placeholder="Отправитель груза" value={sender} onChange={(event) => setSender(event.target.value)} />
        </Label>
        <Label className={small}>
          Телефон получателя
          <Input name="receiverPhone" type="tel" autoComplete="off" maxLength={100} value={receiverPhone} onChange={(event) => setReceiverPhone(event.target.value)} />
        </Label>
      </div>

      <div className="grid grid-cols-2 gap-3 min-[720px]:grid-cols-4 min-[1200px]:grid-cols-7">
        <Label className={cn(small, "col-span-2")}>
          Наименование
          <Input ref={itemInput} name="item" autoComplete="off" maxLength={200} placeholder="Футболка мужская" value={item} onChange={(event) => setItem(event.target.value)} />
        </Label>
        <Label className={small}>
          Бренд
          <Input name="brand" autoComplete="off" maxLength={100} value={brand} onChange={(event) => setBrand(event.target.value)} />
        </Label>
        <Label className={small}>
          Размер
          <Input name="size" autoComplete="off" maxLength={50} placeholder="48-58" value={size} onChange={(event) => setSize(event.target.value)} />
        </Label>
        <Label className={small}>
          Мешков
          <Input name="bags" inputMode="numeric" autoComplete="off" maxLength={9} value={bags} onChange={(event) => setBags(event.target.value)} />
        </Label>
        <Label className={small}>
          В мешке, шт
          <Input name="perBag" inputMode="numeric" autoComplete="off" maxLength={9} value={perBag} onChange={(event) => setPerBag(event.target.value)} />
        </Label>
        <Label className={small}>
          Всего, шт
          <Input
            name="pieces"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            // What the bags come to, until the person types another number.
            placeholder={piecesOfBags === null ? undefined : formatCount(piecesOfBags)}
            value={pieces}
            onChange={(event) => setPieces(event.target.value)}
          />
        </Label>
      </div>

      <div className="grid grid-cols-2 items-end gap-3 min-[720px]:flex min-[720px]:flex-wrap">
        <Label className={cn(small, "min-[720px]:w-36")}>
          Вес, кг
          <Input name="weight" inputMode="decimal" autoComplete="off" maxLength={12} required value={weight} onChange={(event) => setWeight(event.target.value)} />
        </Label>
        <Label className={cn(small, "min-[720px]:w-36")}>
          <span>
            Цена за кг <LabelNote>$</LabelNote>
          </span>
          <Input
            name="price"
            inputMode="decimal"
            autoComplete="off"
            maxLength={9}
            placeholder="клиента"
            value={price}
            onChange={(event) => {
              priceTyped.current = event.target.value.trim() !== "";
              setPrice(event.target.value);
            }}
          />
        </Label>
        <div className={cn(small, "col-span-2 min-[720px]:w-44")}>
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
