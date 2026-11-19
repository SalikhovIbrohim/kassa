import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  addCargo,
  changeCargo,
  changeTrip,
  createTrip,
  deleteCargo,
  deleteTrip,
  fetchTrip,
  fetchTrips,
  NetworkError,
  SessionExpiredError,
  setTripStatus,
  type CargoInput,
  type CargoLine,
  type Trip,
  type TripDetail,
  type TripRefusal,
  type TripResult,
  type TripsPage,
} from "./api";
import { CargoForm } from "./CargoForm";
import { debtWords, formatCount, formatPlace, formatPrice, formatShortDay, formatTripDay, formatUsd, formatWeight, moscowToday, TRIP_STATUS_LABEL, type TripStatus } from "./cargo";
import { Icon } from "./sections";
import { useWarehouses } from "./warehouses";
import { PencilIcon } from "@/components/icons";
import { alertVariants } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label, LabelNote } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Props = {
  onSessionExpired: () => void;
  /** The section is on the screen: what it shows is read again when it comes back to the front. */
  active?: boolean;
};

const WHY_NOT: Record<TripRefusal, string> = {
  "session-expired": "Нужно войти заново.",
  forbidden: "Это может сделать только админ.",
  "not-found": "Такого рейса или строки уже нет. Нажмите «Обновить».",
  "trip-exists": "Рейс с таким номером уже есть.",
  "trip-arrived": "Рейс уже прибыл: накладная закрыта, исправить её может админ.",
  "trip-has-cargo": "В рейсе есть грузы: сначала уберите строки.",
  "wrong-status": "Статус рейса уже другой. Нажмите «Обновить».",
  "arrival-before-departure": "Дата прибытия раньше даты выезда.",
  "unknown-client": "Такого клиента нет в справочнике. Клиента заводит админ в разделе «Клиенты».",
  "price-required": "У клиента нет своей цены за кг: введите цену в строке.",
  "warehouse-forbidden": "Это груз другого склада: его ведёт завсклад того склада.",
  rejected: "Проверьте поля: что-то заполнено неверно.",
  "server-error": "Не получилось сохранить. Попробуйте ещё раз.",
};

const NO_CONNECTION = "Нет связи с сервером. Попробуйте ещё раз, когда она появится.";
const failure = (caught: unknown) => (caught instanceof NetworkError ? NO_CONNECTION : WHY_NOT["server-error"]);

const STATUS_BADGE: Record<TripStatus, "default" | "secondary" | "outline"> = { loading: "secondary", in_transit: "default", arrived: "outline" };

/** What became of a trip in 1C, in words. */
const ONEC_STATUS: Record<string, string> = { pending: "ждёт записи", written: "записан", preview: "репетиция", blocked: "ждёт исправления", failed: "ошибка", skipped: "не записывается", removed: "снят в 1С" };

function StatusBadge({ status }: { status: TripStatus }) {
  return (
    <Badge variant={STATUS_BADGE[status]} data-status={status}>
      {TRIP_STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * «Сборные грузы»: the trips of the business, and behind each its waybill. A trip is a truck that takes the cargo of
 * many clients; when it has arrived, each of them owes for theirs, and what they owe is the same number here and in the
 * cash desk.
 */
export function Trips({ onSessionExpired, active = true }: Props) {
  // The trip whose page is open; none: the list.
  const [open, setOpen] = useState<number | null>(null);
  // null: loading, undefined: did not load.
  const [page, setPage] = useState<TripsPage | null | undefined>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(() => {
    fetchTrips().then(setPage, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setPage((current) => current ?? undefined);
    });
  }, [onSessionExpired]);

  useEffect(() => {
    if (active && open === null) load();
  }, [active, open, load]);

  async function showMore() {
    if (!page?.nextBefore || more) return;
    setMore(true);
    try {
      const next = await fetchTrips(page.nextBefore);
      setPage({ ...next, trips: [...page.trips, ...next.trips] });
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
    } finally {
      setMore(false);
    }
  }

  if (open !== null) {
    return <TripPage key={open} number={open} active={active} onBack={() => setOpen(null)} onRenumbered={setOpen} onSessionExpired={onSessionExpired} />;
  }

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Рейсы">
      <div className="journal-head">
        <h2>Рейсы</h2>
        <div className="flex flex-wrap gap-2">
          {page?.mayCreate && <NewTrip suggested={page.nextNumber} onCreated={(trip) => setOpen(trip.number)} onSessionExpired={onSessionExpired} />}
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </div>

      {page === null && <p className="hint">Загружаем…</p>}
      {page === undefined && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить рейсы. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={load}>
            Повторить
          </Button>
        </>
      )}
      {page && page.trips.length === 0 && <p className="hint">Рейсов пока нет{page.mayCreate ? ": создайте первый." : "."}</p>}

      {page && page.trips.length > 0 && (
        <>
          {/* A computer: a table, a row to a trip. */}
          <div className="glass-card hidden overflow-x-auto rounded-[22px] min-[960px]:block">
            <table className="w-full border-collapse text-[15px]" data-trips>
              <thead>
                <tr className="border-b text-left text-[13px] text-muted-foreground [&_th]:px-4 [&_th]:py-3 [&_th]:font-semibold">
                  <th>№</th>
                  <th>Водитель</th>
                  <th>Машина</th>
                  <th>Погрузка</th>
                  <th>Выезд</th>
                  <th>Прибытие</th>
                  <th>Статус</th>
                  <th className="text-right">Вес, кг</th>
                  <th className="text-right">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {page.trips.map((trip) => (
                  <tr
                    key={trip.number}
                    data-trip={trip.number}
                    className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-muted/60 [&_td]:px-4 [&_td]:py-3"
                    onClick={() => setOpen(trip.number)}
                  >
                    <td>
                      <button type="button" className="font-bold underline-offset-2 hover:underline" aria-label={`Рейс ${trip.number}`}>
                        {trip.number}
                      </button>
                    </td>
                    <td>{trip.driverName}</td>
                    <td className="whitespace-nowrap">{trip.truckPlates}</td>
                    <td className="tabular-nums">{formatTripDay(trip.loadingDay)}</td>
                    <td className="tabular-nums">{formatTripDay(trip.departureDay)}</td>
                    <td className="tabular-nums">{formatTripDay(trip.arrivalDay)}</td>
                    <td>
                      <StatusBadge status={trip.status} />
                    </td>
                    <td className="text-right tabular-nums">{trip.weightG > 0 ? formatWeight(trip.weightG) : ""}</td>
                    <td className="text-right font-semibold tabular-nums">{formatUsd(trip.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* A phone: a card to a trip. */}
          <ul className="glass-card divide-y overflow-hidden rounded-[26px] min-[960px]:hidden">
            {page.trips.map((trip) => (
              <li key={trip.number}>
                <button type="button" className="grid w-full gap-1 px-4 py-3 text-left active:bg-muted" data-trip-card={trip.number} onClick={() => setOpen(trip.number)}>
                  <span className="flex items-center gap-2">
                    <span className="text-[17px] font-bold">Рейс {trip.number}</span>
                    <StatusBadge status={trip.status} />
                    <span className="ml-auto font-semibold tabular-nums">{formatUsd(trip.amountMinor)}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                    {trip.driverName && <span>{trip.driverName}</span>}
                    {trip.departureDay && <span>выезд {formatTripDay(trip.departureDay)}</span>}
                    {trip.arrivalDay && <span>прибыл {formatTripDay(trip.arrivalDay)}</span>}
                    {trip.weightG > 0 && <span className="tabular-nums">{formatWeight(trip.weightG)} кг</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {page.nextBefore !== null && (
            <Button type="button" variant="outline" disabled={more} onClick={() => void showMore()}>
              {more ? "Загружаем…" : "Показать ещё"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** «Новый рейс»: a window with the number (the next one, unless another is typed), the driver, the truck and the day it leaves. */
function NewTrip({ suggested, onCreated, onSessionExpired }: { suggested: number; onCreated: (trip: Trip) => void; onSessionExpired: () => void }) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [truckPlates, setTruckPlates] = useState("");
  const [loadingDay, setLoadingDay] = useState("");
  const [departureDay, setDepartureDay] = useState("");
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    const wanted = Number(number.trim());
    if (!/^[1-9]\d{0,8}$/.test(number.trim())) return setError("Номер рейса: целое число больше нуля, например 193.");
    setBusy(true);
    setError(null);
    try {
      const result = await createTrip({
        number: wanted,
        driverName: driverName.trim() || null,
        driverPhone: driverPhone.trim() || null,
        truckPlates: truckPlates.trim() || null,
        direction: direction.trim() || null,
        loadingDay: loadingDay || null,
        departureDay: departureDay || null,
      });
      if (result.ok && result.detail) {
        setOpen(false);
        toast(`Рейс ${result.detail.trip.number} создан`);
        onCreated(result.detail.trip);
      } else if (!result.ok && result.reason === "session-expired") onSessionExpired();
      else if (!result.ok) setError(WHY_NOT[result.reason]);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Opened anew: the next number and today for the loading, nothing left of the last time. The day it leaves
          // is not known yet: «Фура выехала» sets it.
          setNumber(String(suggested));
          setDriverName("");
          setDriverPhone("");
          setTruckPlates("");
          setLoadingDay(moscowToday());
          setDepartureDay("");
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          + Новый рейс
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Новый рейс</DialogTitle>
        <DialogDescription className="sr-only">Номер рейса, направление, даты погрузки и выезда, водитель и машина.</DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={add} aria-label="Новый рейс">
          <div className="grid grid-cols-2 gap-3">
            <Label>
              № рейса
              <Input name="number" inputMode="numeric" autoComplete="off" maxLength={9} required autoFocus value={number} onChange={(event) => setNumber(event.target.value)} />
            </Label>
            <Label>
              Дата погрузки
              <Input name="loadingDay" type="date" value={loadingDay} onChange={(event) => setLoadingDay(event.target.value)} />
            </Label>
          </div>
          <Label>
            Направление
            <Input name="direction" autoComplete="off" maxLength={100} placeholder="АНДИЖОН - МОСКВА (через КЗХ)" value={direction} onChange={(event) => setDirection(event.target.value)} />
          </Label>
          <Label>
            <span>
              Дата выезда <LabelNote>(если уже известна)</LabelNote>
            </span>
            <Input name="departureDay" type="date" value={departureDay} onChange={(event) => setDepartureDay(event.target.value)} />
          </Label>
          <Label>
            Водитель
            <Input name="driverName" autoComplete="off" maxLength={100} placeholder="Имя водителя" value={driverName} onChange={(event) => setDriverName(event.target.value)} />
          </Label>
          <Label>
            Телефон водителя
            <Input name="driverPhone" type="tel" autoComplete="off" maxLength={100} placeholder="99890 123 45 67" value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} />
          </Label>
          <Label>
            Госномера
            <Input name="truckPlates" autoComplete="off" maxLength={100} placeholder="01 019 OKA / 01 55 39 BA" value={truckPlates} onChange={(event) => setTruckPlates(event.target.value)} />
          </Label>
          {error && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              {error}
            </p>
          )}
          <div className="queue-actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Создаём…" : "Создать рейс"}
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Отмена
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type PageProps = {
  number: number;
  active: boolean;
  onBack: () => void;
  /** The admin gave the trip another number: the page goes on under it. */
  onRenumbered: (number: number) => void;
  onSessionExpired: () => void;
};

/** One trip: the truck and its driver, the waybill line by line, what each client has on it and owes, and what it all comes to. */
function TripPage({ number, active, onBack, onRenumbered, onSessionExpired }: PageProps) {
  const { labelOf, warehouses } = useWarehouses();
  // null: loading, undefined: did not load, "gone": there is no such trip (any more).
  const [detail, setDetail] = useState<TripDetail | null | undefined | "gone">(null);
  const [busy, setBusy] = useState(false);
  // Why the server did not take a line (said in the form of the cargo), and why not anything else (said on top).
  const [cargoError, setCargoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CargoLine | null>(null);
  const [removing, setRemoving] = useState<CargoLine | null>(null);
  // Only the newest answer may update the page.
  const newest = useRef(0);
  // The id of the line that is being added: the same for as long as the same line is sent again (an answer that was
  // lost), so that the server stores it once.
  const adding = useRef<{ key: string; id: string } | null>(null);

  async function add(input: CargoInput): Promise<boolean> {
    const key = JSON.stringify(input);
    if (adding.current?.key !== key) adding.current = { key, id: crypto.randomUUID() };
    const { id } = adding.current;
    const taken = await apply(() => addCargo(number, id, input), { done: "Груз добавлен", say: setCargoError });
    if (taken) adding.current = null;
    return taken;
  }

  const load = useCallback(() => {
    const mine = ++newest.current;
    fetchTrip(number).then(
      (loaded) => {
        if (mine === newest.current) setDetail(loaded ?? "gone");
      },
      (caught: unknown) => {
        if (mine !== newest.current) return;
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setDetail((current) => current ?? undefined);
      },
    );
  }, [number, onSessionExpired]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  /** Sends one change, and shows the trip as the server says it is afterwards. True when it was taken. */
  async function apply(work: () => Promise<TripResult>, options: { done?: string; say?: (text: string) => void } = {}): Promise<boolean> {
    if (busy) return false;
    const say = options.say ?? setError;
    setBusy(true);
    setError(null);
    setCargoError(null);
    try {
      const result = await work();
      if (result.ok) {
        newest.current++;
        if (result.detail === null) {
          toast(options.done ?? "Готово");
          onBack();
          return true;
        }
        setDetail(result.detail);
        if (result.detail.trip.number !== number) onRenumbered(result.detail.trip.number);
        if (options.done) toast(options.done);
        return true;
      }
      if (result.reason === "session-expired") onSessionExpired();
      else {
        say(WHY_NOT[result.reason]);
        // Somebody else changed the trip meanwhile: show it as it is now.
        if (result.reason === "wrong-status" || result.reason === "trip-arrived" || result.reason === "not-found") load();
      }
    } catch (caught) {
      say(failure(caught));
    } finally {
      setBusy(false);
    }
    return false;
  }

  const back = (
    <button type="button" className="-ml-1 flex w-fit items-center gap-1 text-[15px] font-semibold text-muted-foreground hover:text-foreground" onClick={onBack}>
      <Icon name="chevronLeft" size={18} stroke={2.2} />
      Все рейсы
    </button>
  );

  if (detail === null || detail === undefined || detail === "gone") {
    return (
      <section className="flex min-w-0 flex-col gap-4" aria-label={`Рейс ${number}`}>
        {back}
        {detail === null && <p className="hint">Загружаем…</p>}
        {detail === "gone" && <p className="hint">Рейса {number} нет: его убрали или дали ему другой номер.</p>}
        {detail === undefined && (
          <>
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              Не удалось загрузить рейс. Проверьте связь и попробуйте ещё раз.
            </p>
            <Button type="button" variant="outline" onClick={load}>
              Повторить
            </Button>
          </>
        )}
      </section>
    );
  }

  const { trip, cargo, clients, may, money, onec } = detail;
  const places = detail.places ?? { head: 0, trailer: 0 };
  const writes = may.warehouses.length > 0;
  const anyMine = cargo.some((line) => line.mine);
  // The warehouse the truck starts from: its lines are written without its name, as the waybill has them.
  const firstWarehouse = warehouses[0]?.id;
  // The size and what is in one bag are in the form for the waybills that say them; a waybill that says neither has no
  // empty columns of them.
  const sized = cargo.some((line) => line.size !== null);
  const perBagged = cargo.some((line) => line.perBag !== null);

  return (
    // min-w-0: the waybill is wider than a small laptop, and scrolls inside its card instead of widening the page.
    <section className="flex min-w-0 flex-col gap-4" aria-label={`Рейс ${trip.number}`} aria-busy={busy} data-trip-page={trip.number}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-2">
          {back}
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-bold tracking-tight">Рейс {trip.number}</h2>
            <StatusBadge status={trip.status} />
            {trip.arrivalDay && <span className="text-sm text-muted-foreground">прибыл {formatTripDay(trip.arrivalDay)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {may.back && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void apply(() => setTripStatus(trip.number, may.back!), { done: may.back === "in_transit" ? "Рейс снова в пути: долги по нему сняты" : "Рейс снова грузится" })}
            >
              {may.back === "in_transit" ? "Вернуть в путь" : "Вернуть на погрузку"}
            </Button>
          )}
          {may.forward === "in_transit" && (
            <Button type="button" size="sm" disabled={busy} onClick={() => void apply(() => setTripStatus(trip.number, "in_transit"), { done: "Рейс отправлен в путь" })}>
              Фура выехала →
            </Button>
          )}
          {may.forward === "arrived" && (
            <Arrival busy={busy} departureDay={trip.departureDay} onArrived={(day) => apply(() => setTripStatus(trip.number, "arrived", day), { done: "Рейс прибыл: долги начислены" })} />
          )}
          {may.remove && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void apply(() => deleteTrip(trip.number), { done: `Рейс ${trip.number} удалён` })}>
              Удалить рейс
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </div>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}

      <TripHeaderForm key={`${trip.number}-${trip.status}-${trip.arrivalDay}`} trip={trip} may={may} busy={busy} onSave={(change) => apply(() => changeTrip(trip.number, change), { done: "Сохранено" })} />

      {writes && (
        <div className="glass-card grid gap-3 rounded-xl p-4">
          <h3 className="font-semibold">Добавить груз</h3>
          <CargoForm
            warehouses={may.warehouses}
            busy={busy}
            error={editing ? null : cargoError}
            onSubmit={add}
          />
        </div>
      )}

      {trip.fromCardFile ? (
        <p className={alertVariants({ variant: "info" })} data-from-card-file>
          Рейс из картотеки: накладной здесь нет, только сумма каждого клиента (ниже). Строки груза в такой рейс не вносятся.
        </p>
      ) : cargo.length === 0 ? (
        <p className="hint">Грузов пока нет{writes ? ": добавьте первую строку." : "."}</p>
      ) : (
        <>
          {/* A computer: the waybill as a table, a row to a line. */}
          <div className="glass-card hidden overflow-x-auto rounded-[22px] min-[960px]:block">
            <table className="w-full border-collapse text-[13.5px]" data-cargo>
              <thead>
                <tr className="border-b text-left text-[12.5px] text-muted-foreground [&_th]:px-2 [&_th]:py-3 [&_th]:font-semibold [&_th:first-child]:pl-4">
                  <th>Место</th>
                  <th>Дата</th>
                  <th>Получатель</th>
                  <th>Код</th>
                  <th>Телефон</th>
                  <th>Бренд</th>
                  <th>Наименование</th>
                  {sized && <th>Размер</th>}
                  <th className="text-right">Места</th>
                  {perBagged && <th className="text-right">В мешке</th>}
                  <th>Вид упк.</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Общий вес</th>
                  <th className="text-right">Цена</th>
                  <th>Отправитель</th>
                  <th className="text-right">Сумма</th>
                  {anyMine && <th />}
                </tr>
              </thead>
              <tbody>
                {cargo.map((line) => (
                  <tr key={line.id} data-cargo-line={line.id} className="border-b last:border-b-0 [&_td]:px-2 [&_td]:py-2 [&_td:first-child]:pl-4 [&_td:last-child]:pr-3">
                    {/* As the waybill writes it: «Голова 3», and for the cargo of another warehouse «Коканд · Голова 1». */}
                    <td className="whitespace-nowrap">
                      {[line.warehouse === firstWarehouse ? "" : labelOf(line.warehouse), formatPlace(line.truckPart, line.place)].filter(Boolean).join(" · ") || labelOf(line.warehouse)}
                    </td>
                    <td className="tabular-nums">{formatShortDay(line.acceptedDay)}</td>
                    <td>{line.receiver ?? line.clientName}</td>
                    <td className="font-semibold tabular-nums">{line.clientCode}</td>
                    <td className="whitespace-nowrap">{line.receiverPhone}</td>
                    <td>{line.brand}</td>
                    <td>{line.item}</td>
                    {sized && <td>{line.size}</td>}
                    <td className="text-right tabular-nums">{formatCount(line.bags)}</td>
                    {perBagged && <td className="text-right tabular-nums">{formatCount(line.perBag)}</td>}
                    <td className="whitespace-nowrap">{line.packaging}</td>
                    <td className="text-right tabular-nums">{formatCount(line.pieces)}</td>
                    <td className="text-right tabular-nums">{formatWeight(line.weightG)}</td>
                    <td className="text-right tabular-nums">{formatPrice(line.priceMilli)}</td>
                    <td>{line.sender}</td>
                    <td className="text-right font-semibold whitespace-nowrap tabular-nums">{formatUsd(line.amountMinor)}</td>
                    {anyMine && (
                      <td>
                        {line.mine && <LineButtons line={line} busy={busy} onEdit={() => (setCargoError(null), setEditing(line))} onRemove={() => setRemoving(line)} />}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* A phone: a card to a line. */}
          <ul className="glass-card divide-y overflow-hidden rounded-[26px] min-[960px]:hidden">
            {cargo.map((line) => (
              <li key={line.id} className="grid gap-1 px-4 py-3" data-cargo-card={line.id}>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">
                      {line.receiver ?? line.clientName} <span className="tabular-nums">{line.clientCode}</span>
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {[labelOf(line.warehouse), formatPlace(line.truckPart, line.place), formatShortDay(line.acceptedDay), line.brand, line.item, line.size].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="text-right font-semibold tabular-nums">{formatUsd(line.amountMinor)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                  <span className="tabular-nums">
                    {formatWeight(line.weightG)} кг × {formatPrice(line.priceMilli)} $
                  </span>
                  {line.bags !== null && (
                    <span className="tabular-nums">
                      мест {formatCount(line.bags)}
                      {line.packaging ? ` (${line.packaging})` : ""}
                    </span>
                  )}
                  {line.pieces !== null && <span className="tabular-nums">шт {formatCount(line.pieces)}</span>}
                  {line.sender && <span>от {line.sender}</span>}
                  {line.mine && (
                    <span className="ml-auto">
                      <LineButtons line={line} busy={busy} onEdit={() => (setCargoError(null), setEditing(line))} onRemove={() => setRemoving(line)} />
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {clients.length > 0 && (
        <div className="grid gap-4 min-[960px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="glass-card grid gap-3 rounded-xl p-4">
            <h3 className="font-semibold">Итоги по клиентам (жами)</h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" data-client-totals>
                <thead>
                  <tr className="border-b text-left text-[13px] text-muted-foreground [&_th]:px-2 [&_th]:py-2 [&_th]:font-semibold">
                    <th>Код</th>
                    <th>Клиент</th>
                    {/* A phone has room for the money only: the places and the weight are in the lines above. */}
                    {!trip.fromCardFile && <th className="hidden text-right min-[640px]:table-cell">Мест</th>}
                    {!trip.fromCardFile && <th className="hidden text-right min-[640px]:table-cell">Вес, кг</th>}
                    <th className="text-right">Сумма</th>
                    <th className="text-right">Сейчас должен</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => {
                    const owes = debtWords(client.debtMinor);
                    return (
                      <tr key={client.code} data-client-total={client.code} className="border-b last:border-b-0 [&_td]:px-2 [&_td]:py-2">
                        <td className="font-semibold tabular-nums">{client.code}</td>
                        <td>{client.name}</td>
                        {!trip.fromCardFile && <td className="hidden text-right tabular-nums min-[640px]:table-cell">{client.bags > 0 ? formatCount(client.bags) : ""}</td>}
                        {!trip.fromCardFile && <td className="hidden text-right tabular-nums min-[640px]:table-cell">{client.weightG > 0 ? formatWeight(client.weightG) : ""}</td>}
                        <td className="text-right font-semibold whitespace-nowrap tabular-nums">{formatUsd(client.amountMinor)}</td>
                        <td className={cn("text-right whitespace-nowrap tabular-nums", owes.tone === "debt" ? "text-destructive" : owes.tone === "ahead" ? "text-success" : "text-muted-foreground")}>
                          {owes.tone === "even" ? "—" : owes.tone === "ahead" ? `−${formatUsd(-client.debtMinor)}` : formatUsd(client.debtMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted-foreground">
              «Сейчас должен» это весь долг клиента: грузы прибывших рейсов минус его оплаты в кассе. Груз этого рейса входит в долг с даты прибытия.
            </p>
          </div>

          <div className="glass-card grid content-start gap-2 rounded-xl p-4 text-[15px]" data-trip-totals>
            <h3 className="font-semibold">Итог фуры</h3>
            {!trip.fromCardFile && <Total label="Строк груза" value={formatCount(trip.lines)} />}
            <Total label="Клиентов" value={formatCount(clients.length)} />
            {!trip.fromCardFile && (
              <>
                {(places.head > 0 || places.trailer > 0) && <Total label="Голова / Прицеп, мест" value={`${formatCount(places.head)} / ${formatCount(places.trailer)}`} />}
                <Total label="Всего мест" value={formatCount(trip.bags)} />
                <Total label="Общий вес" value={`${formatWeight(trip.weightG)} кг`} />
              </>
            )}
            <Total label="Сумма в фуре" value={formatUsd(trip.amountMinor)} strong />
            {money && (
              <>
                <Total label="Расходы рейса (из кассы)" value={formatUsd(money.expenseMinor)} />
                <Total label="Остаётся" value={formatUsd(money.profitMinor)} strong />
              </>
            )}
          </div>
          {onec && (
            <p className="mt-2 text-[13px] leading-snug text-muted-foreground" data-onec={onec.status}>
              <b className="font-semibold text-foreground">1С: {ONEC_STATUS[onec.status] ?? onec.status}</b>
              {onec.docNumber && ` · «Оказание услуг» №${onec.docNumber}`}
              {onec.detail && onec.status !== "written" && ` · ${onec.detail}`}
            </p>
          )}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}>
        <DialogContent className="min-[640px]:max-w-3xl">
          <DialogTitle>Изменить груз</DialogTitle>
          <DialogDescription className="sr-only">Склад, клиент, товар, вес и цена этой строки накладной.</DialogDescription>
          {editing && (
            <CargoForm
              key={editing.id}
              // A line of a warehouse this person does not write any more is still shown with its own.
              warehouses={may.warehouses.includes(editing.warehouse) ? may.warehouses : [editing.warehouse, ...may.warehouses]}
              line={editing}
              busy={busy}
              error={cargoError}
              onCancel={() => setEditing(null)}
              onSubmit={async (input) => {
                const taken = await apply(() => changeCargo(trip.number, editing.id, input), { done: "Сохранено", say: setCargoError });
                if (taken) setEditing(null);
                return taken;
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogTitle>Удалить строку груза?</DialogTitle>
          {removing && (
            <>
              <DialogDescription>
                {removing.receiver ?? removing.clientName} {removing.clientCode}: {formatWeight(removing.weightG)} кг, {formatUsd(removing.amountMinor)}. Строка уйдёт из накладной, в истории рейса она останется.
              </DialogDescription>
              <div className="queue-actions">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    await apply(() => deleteCargo(trip.number, removing.id), { done: "Строка удалена" });
                    setRemoving(null);
                  }}
                >
                  Да, удалить
                </Button>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Нет
                  </Button>
                </DialogClose>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Total({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "text-base font-semibold")}>
      <span className={strong ? undefined : "text-muted-foreground"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function LineButtons({ line, busy, onEdit, onRemove }: { line: CargoLine; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const what = `${line.receiver ?? line.clientName} ${line.clientCode}`.trim();
  return (
    <span className="flex justify-end gap-1">
      <Button type="button" variant="outline" size="icon" className="size-8" disabled={busy} aria-label={`Изменить груз: ${what}`} title="Изменить" onClick={onEdit}>
        <PencilIcon />
      </Button>
      <Button type="button" variant="outline" size="icon" className="size-8" disabled={busy} aria-label={`Удалить груз: ${what}`} title="Удалить" onClick={onRemove}>
        <Icon name="trash" size={16} />
      </Button>
    </span>
  );
}

/** «Рейс прибыл»: asks for the day, because from that day the cargo of the trip is owed by its clients. */
function Arrival({ busy, departureDay, onArrived }: { busy: boolean; departureDay: string | null; onArrived: (day: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDay(moscowToday());
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" disabled={busy}>
          Рейс прибыл
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Прибытие рейса</DialogTitle>
        <DialogDescription>После подтверждения долг по грузам этого рейса начисляется клиентам с этой даты.</DialogDescription>
        <form
          className="flex flex-col gap-3"
          aria-label="Прибытие рейса"
          onSubmit={async (event) => {
            event.preventDefault();
            event.stopPropagation();
            // Closed either way: what the server said, if it did not take the day, is said on the page.
            await onArrived(day);
            setOpen(false);
          }}
        >
          <Label>
            Дата прибытия
            <Input name="arrivalDay" type="date" required min={departureDay ?? undefined} value={day} onChange={(event) => setDay(event.target.value)} />
          </Label>
          <div className="queue-actions">
            <Button type="submit" disabled={busy || day === ""}>
              Подтвердить прибытие
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Отмена
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type HeaderChange = Parameters<typeof changeTrip>[1];

/** «Фура и водитель»: the header of the trip. The number and the day of arrival are the admin's to put right. */
function TripHeaderForm({ trip, may, busy, onSave }: { trip: Trip; may: TripDetail["may"]; busy: boolean; onSave: (change: HeaderChange) => Promise<boolean> }) {
  const [number, setNumber] = useState(String(trip.number));
  const [driverName, setDriverName] = useState(trip.driverName ?? "");
  const [driverPhone, setDriverPhone] = useState(trip.driverPhone ?? "");
  const [truckPlates, setTruckPlates] = useState(trip.truckPlates ?? "");
  const [direction, setDirection] = useState(trip.direction ?? "");
  const [loadingDay, setLoadingDay] = useState(trip.loadingDay ?? "");
  const [departureDay, setDepartureDay] = useState(trip.departureDay ?? "");
  const [arrivalDay, setArrivalDay] = useState(trip.arrivalDay ?? "");
  const [note, setNote] = useState(trip.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (may.admin && !/^[1-9]\d{0,8}$/.test(number.trim())) return setProblem("Номер рейса: целое число больше нуля.");
    const change: HeaderChange = {
      ...(driverName.trim() === (trip.driverName ?? "") ? {} : { driverName: driverName.trim() || null }),
      ...(driverPhone.trim() === (trip.driverPhone ?? "") ? {} : { driverPhone: driverPhone.trim() || null }),
      ...(truckPlates.trim() === (trip.truckPlates ?? "") ? {} : { truckPlates: truckPlates.trim() || null }),
      ...(note.trim() === (trip.note ?? "") ? {} : { note: note.trim() || null }),
      ...(direction.trim() === (trip.direction ?? "") ? {} : { direction: direction.trim() || null }),
      ...(loadingDay === (trip.loadingDay ?? "") ? {} : { loadingDay: loadingDay || null }),
      ...(departureDay === (trip.departureDay ?? "") ? {} : { departureDay: departureDay || null }),
      ...(may.admin && Number(number.trim()) !== trip.number ? { number: Number(number.trim()) } : {}),
      ...(may.admin && trip.status === "arrived" && arrivalDay !== "" && arrivalDay !== trip.arrivalDay ? { arrivalDay } : {}),
    };
    if (Object.keys(change).length > 0) void onSave(change);
  }

  const small = "grid content-start gap-1.5 text-sm font-semibold";
  return (
    <form className="glass-card grid gap-3 rounded-xl p-4" onSubmit={save} aria-label="Фура и водитель">
      <h3 className="font-semibold">Фура и водитель</h3>
      <div className="grid grid-cols-2 items-end gap-3 min-[960px]:grid-cols-4 min-[1200px]:grid-cols-6">
        {may.admin && (
          <Label className={small}>
            № рейса
            <Input name="number" inputMode="numeric" autoComplete="off" maxLength={9} value={number} onChange={(event) => setNumber(event.target.value)} />
          </Label>
        )}
        <Label className={small}>
          Водитель
          <Input name="driverName" autoComplete="off" maxLength={100} disabled={!may.edit} value={driverName} onChange={(event) => setDriverName(event.target.value)} />
        </Label>
        <Label className={small}>
          Телефон
          <Input name="driverPhone" type="tel" autoComplete="off" maxLength={100} disabled={!may.edit} value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} />
        </Label>
        <Label className={small}>
          Госномера
          <Input name="truckPlates" autoComplete="off" maxLength={100} disabled={!may.edit} value={truckPlates} onChange={(event) => setTruckPlates(event.target.value)} />
        </Label>
        <Label className={small}>
          Дата погрузки
          <Input name="loadingDay" type="date" disabled={!may.edit} value={loadingDay} onChange={(event) => setLoadingDay(event.target.value)} />
        </Label>
        <Label className={small}>
          Дата выезда
          <Input name="departureDay" type="date" disabled={!may.edit} value={departureDay} onChange={(event) => setDepartureDay(event.target.value)} />
        </Label>
        {trip.status === "arrived" && (
          <Label className={small}>
            Дата прибытия
            <Input name="arrivalDay" type="date" disabled={!may.admin} value={arrivalDay} onChange={(event) => setArrivalDay(event.target.value)} />
          </Label>
        )}
        <Label className={cn(small, "col-span-2")}>
          Направление
          <Input name="direction" autoComplete="off" maxLength={100} placeholder="АНДИЖОН - МОСКВА (через КЗХ)" disabled={!may.edit} value={direction} onChange={(event) => setDirection(event.target.value)} />
        </Label>
        <Label className={cn(small, "col-span-2")}>
          <span>
            Заметка <LabelNote>(по желанию)</LabelNote>
          </span>
          <Input name="note" autoComplete="off" maxLength={500} disabled={!may.edit} value={note} onChange={(event) => setNote(event.target.value)} />
        </Label>
        {may.edit && (
          <Button type="submit" variant="outline" disabled={busy} className="col-span-2 min-[960px]:col-span-1">
            Сохранить
          </Button>
        )}
      </div>
      {problem && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
