import { createHash } from "node:crypto";
import type pg from "pg";
import { readControl, type ControlMonth } from "../client-debts.js";
import { clientCodeIn, type ClientCodes } from "../clients.js";
import type { Kassas } from "../kassa.js";
import { inTransaction } from "../ledger.js";
import { cleanText } from "../text.js";
import type { Warehouses } from "../warehouses.js";
import { AdminError } from "./users.js";

/**
 * The history of a business that kept its trips and its payments in a card file before it kept them here, as one file
 * (JSON; tools/express makes it from the spreadsheets of the business). Loading it makes the directory of clients,
 * what each owed at the start, the trips of before with the sum of each client, the payments of before, and the
 * waybills of the trips that are still on the road. Nothing of it is an entry of the cash book.
 */
export type HistoryFile = {
  clients: Array<{ code: string; name: string; openingDebtMinor?: number }>;
  /** The trips of before, which have arrived: a sum to a client, in millionths of a dollar. */
  trips: Array<{ number: number; arrivalDay: string; sums: Array<{ code: string; amountMicro: number; note?: string | null }> }>;
  /** The payments of before; `kassa` is the cash desk that took it, where the card file says. */
  payments: Array<{ code: string; day: string; amountMinor: number; kassa?: string | null; note?: string | null }>;
  /** The trips that have not arrived yet, with every line of their waybills. */
  waybills?: Array<{
    number: number;
    status: "loading" | "in_transit";
    loadingDay?: string | null;
    departureDay?: string | null;
    direction?: string | null;
    driverName?: string | null;
    driverPhone?: string | null;
    truckPlates?: string | null;
    lines: Array<{
      warehouse: string;
      truckPart?: "head" | "trailer" | null;
      acceptedDay?: string | null;
      code: string;
      receiver?: string | null;
      receiverPhone?: string | null;
      sender?: string | null;
      item?: string | null;
      brand?: string | null;
      size?: string | null;
      bags?: number | null;
      perBag?: number | null;
      packaging?: string | null;
      pieces?: number | null;
      weightG: number;
      priceMilli: number;
    }>;
  }>;
  /** The control sheet of the card file, month by month: what the load is compared with afterwards. */
  control?: ControlMonth[];
};

export type HistoryReport = {
  clients: { added: number; there: number };
  trips: { added: number; there: number; removed: number; sums: number };
  payments: number;
  waybills: Array<{ number: number; lines: number; note: string }>;
  /** The control sheet as the database has it after the load, and next to it what the file said (when it said). */
  control: Array<ControlMonth & { file?: ControlMonth }>;
};

const isDay = (day: unknown): day is string => {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day;
};
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const blank = (value: string | null | undefined) => (value === undefined || value === null ? null : cleanText(value) || null);

/** An id that is the same every time the same line of the same waybill is loaded, so that loading twice adds nothing. */
function lineId(trip: number, index: number): string {
  const hex = createHash("sha1").update(`kassa.waybill.${trip}.${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Loads a history file, all of it or nothing. Loading it again (a card file that was put right) replaces the history
 * loaded before: the trips of the history and their sums, the payments of before, the opening debts. What is kept here
 * since (the entries of the cash book, the trips with waybills) is not touched, and a trip of the file whose number a
 * trip kept here has is a mistake that stops the load.
 */
export async function importHistory(
  pool: pg.Pool,
  file: HistoryFile,
  options: { warehouses: Warehouses; kassas: Kassas; clientCodes: ClientCodes; actorLogin?: string; now?: Date },
): Promise<HistoryReport> {
  const { warehouses, kassas, clientCodes } = options;
  const problems: string[] = [];
  const say = (problem: string) => {
    if (problems.length < 20) problems.push(problem);
  };
  const codeOf = (typed: unknown, where: string): string => {
    const code = typeof typed === "string" ? clientCodeIn(typed, clientCodes) : null;
    if (!code) say(`${where}: "${String(typed)}" is not a code of a client`);
    return code ?? "";
  };
  if (!warehouses.enabled) throw new AdminError("The settings name no warehouse (WAREHOUSES): this installation keeps no trips to load a history of.");

  // What the file says, checked before anything is written.
  const clients = (file.clients ?? []).map((item, index) => {
    const code = codeOf(item.code, `clients[${index}]`);
    const name = cleanText(String(item.name ?? ""));
    if (name === "") say(`clients[${index}] (${code}): a client has a name`);
    const opening = item.openingDebtMinor ?? 0;
    if (!whole(opening, -10_000_000_000, 10_000_000_000)) say(`clients[${index}] (${code}): the opening debt is not a whole number of cents`);
    return { code, name, opening };
  });
  const twice = clients.map((item) => item.code).filter((code, index, all) => code && all.indexOf(code) !== index);
  if (twice.length > 0) say(`clients: a code is there twice: ${[...new Set(twice)].join(", ")}`);

  const trips = (file.trips ?? []).map((trip, index) => {
    if (!whole(trip.number, 1, 999_999_999)) say(`trips[${index}]: ${String(trip.number)} is not the number of a trip`);
    if (!isDay(trip.arrivalDay)) say(`trip ${trip.number}: "${String(trip.arrivalDay)}" is not the day it arrived`);
    const sums = (trip.sums ?? []).map((sum) => {
      const code = codeOf(sum.code, `trip ${trip.number}`);
      if (!whole(sum.amountMicro, 1, 1_000_000_000_000_000)) say(`trip ${trip.number}, client ${code}: the sum is not a whole number of millionths of a dollar`);
      return { code, micro: sum.amountMicro, note: blank(sum.note) };
    });
    return { number: trip.number, arrivalDay: trip.arrivalDay, sums };
  });
  const tripTwice = trips.map((trip) => trip.number).filter((number, index, all) => all.indexOf(number) !== index);
  if (tripTwice.length > 0) say(`trips: a number is there twice: ${[...new Set(tripTwice)].join(", ")}`);

  const payments = (file.payments ?? []).map((payment, index) => {
    const code = codeOf(payment.code, `payments[${index}]`);
    if (!isDay(payment.day)) say(`payments[${index}] (${code}): "${String(payment.day)}" is not a day`);
    if (!whole(payment.amountMinor, 1, 10_000_000_000)) say(`payments[${index}] (${code}): the amount is not a whole number of cents`);
    const kassa = payment.kassa ?? null;
    if (kassa !== null && !kassas.has(kassa)) say(`payments[${index}] (${code}): "${kassa}" is not a cash desk of KASSAS (${kassas.ids.join(", ")})`);
    return { code, day: payment.day, minor: payment.amountMinor, kassa, note: blank(payment.note) };
  });

  const waybills = (file.waybills ?? []).map((waybill, index) => {
    if (!whole(waybill.number, 1, 999_999_999)) say(`waybills[${index}]: ${String(waybill.number)} is not the number of a trip`);
    if (waybill.status !== "loading" && waybill.status !== "in_transit") say(`waybill ${waybill.number}: the status is loading or in_transit`);
    for (const day of [waybill.loadingDay, waybill.departureDay]) if (day !== undefined && day !== null && !isDay(day)) say(`waybill ${waybill.number}: "${day}" is not a day`);
    const lines = (waybill.lines ?? []).map((line, at) => {
      const where = `waybill ${waybill.number}, line ${at + 1}`;
      const code = codeOf(line.code, where);
      if (!warehouses.has(line.warehouse)) say(`${where}: "${line.warehouse}" is not a warehouse of WAREHOUSES (${warehouses.ids.join(", ")})`);
      if (line.truckPart !== undefined && line.truckPart !== null && line.truckPart !== "head" && line.truckPart !== "trailer") say(`${where}: the part of the truck is head or trailer`);
      if (line.acceptedDay !== undefined && line.acceptedDay !== null && !isDay(line.acceptedDay)) say(`${where}: "${line.acceptedDay}" is not a day`);
      if (!whole(line.weightG, 1, 1_000_000_000)) say(`${where}: the weight is not a whole number of grams`);
      if (!whole(line.priceMilli, 0, 1_000_000)) say(`${where}: the price is not a whole number of thousandths of a dollar`);
      for (const [name, value, max] of [["bags", line.bags, 1_000_000], ["perBag", line.perBag, 1_000_000], ["pieces", line.pieces, 1_000_000_000]] as const) {
        if (value !== undefined && value !== null && !whole(value, 0, max)) say(`${where}: ${name} is not a whole number`);
      }
      return { ...line, code };
    });
    return { ...waybill, lines };
  });
  if (trips.some((trip) => waybills.some((waybill) => waybill.number === trip.number))) say("a trip is among the trips of before and among the waybills at once");
  if (problems.length > 0) throw new AdminError(`The history file cannot be loaded:\n  ${problems.join("\n  ")}`);

  return inTransaction(pool, async (db): Promise<HistoryReport> => {
    const at = options.now ?? new Date();
    // Whoever the trips of the history are written down under: the admin named, or the first one there is.
    const actor = await db.query<{ id: string }>(
      options.actorLogin
        ? "SELECT id FROM users WHERE lower(login) = lower($1) AND active"
        : "SELECT id FROM users WHERE role = 'admin' AND active ORDER BY created_at, id LIMIT 1",
      options.actorLogin ? [options.actorLogin] : [],
    );
    const actorId = actor.rows[0]?.id;
    if (!actorId) throw new AdminError(options.actorLogin ? `There is no active user "${options.actorLogin}"` : "There is no admin yet: make one first (create-user --role admin)");

    // The clients: a new code is added; one that is there keeps its name (unless it has none) and gets the opening debt of the file.
    const known = new Set((await db.query<{ code: string }>("SELECT code FROM clients")).rows.map((row) => row.code));
    let added = 0;
    for (const client of clients) {
      if (!known.has(client.code)) added++;
      await db.query(
        `INSERT INTO clients (code, name, opening_debt_minor) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = CASE WHEN clients.name = '' THEN EXCLUDED.name ELSE clients.name END, opening_debt_minor = EXCLUDED.opening_debt_minor`,
        [client.code, client.name, client.opening],
      );
      known.add(client.code);
    }
    const strangers = new Set<string>();
    for (const code of [...trips.flatMap((trip) => trip.sums.map((sum) => sum.code)), ...payments.map((payment) => payment.code), ...waybills.flatMap((waybill) => waybill.lines.map((line) => line.code))]) {
      if (!known.has(code)) strangers.add(code);
    }
    if (strangers.size > 0) throw new AdminError(`The history file names clients that are neither in it nor in the directory: ${[...strangers].slice(0, 20).join(", ")}`);

    // The trips of before. A trip kept here under the same number is never written over.
    const there = new Map(
      (await db.query<{ id: string; number: number; from_card_file: boolean }>("SELECT id, number, from_card_file FROM trips WHERE deleted_at IS NULL")).rows.map((row) => [row.number, row]),
    );
    const clash = trips.filter((trip) => there.get(trip.number)?.from_card_file === false).map((trip) => trip.number);
    if (clash.length > 0) throw new AdminError(`These trips of the history file are kept here already, with waybills of their own: ${clash.join(", ")}. Take them out of the file, or out of «Сборные грузы».`);

    let tripsAdded = 0;
    let tripsThere = 0;
    const ids = new Map<number, string>();
    for (const trip of trips) {
      const row = there.get(trip.number);
      if (row) {
        tripsThere++;
        await db.query("UPDATE trips SET arrival_day = $2, status = 'arrived' WHERE id = $1", [row.id, trip.arrivalDay]);
        ids.set(trip.number, row.id);
      } else {
        tripsAdded++;
        const made = await db.query<{ id: string }>(
          "INSERT INTO trips (number, status, arrival_day, from_card_file, created_by, created_at) VALUES ($1, 'arrived', $2, true, $3, $4) RETURNING id",
          [trip.number, trip.arrivalDay, actorId, at],
        );
        ids.set(trip.number, made.rows[0]!.id);
        await db.query("INSERT INTO trip_changes (trip_id, action, changed_at, changed_by, state_after) VALUES ($1, 'create', $2, $3, $4)", [
          made.rows[0]!.id,
          at,
          actorId,
          JSON.stringify({ number: trip.number, arrivalDay: trip.arrivalDay, status: "arrived", fromCardFile: true }),
        ]);
      }
    }
    // The sums are the file's, whole: those loaded before go, and a trip of the history that the file has no more goes with them.
    await db.query("DELETE FROM trip_sums WHERE trip_id IN (SELECT id FROM trips WHERE from_card_file)");
    const gone = [...there.values()].filter((row) => row.from_card_file && !ids.has(row.number));
    for (const row of gone) await db.query("UPDATE trips SET deleted_at = $2, deleted_by = $3 WHERE id = $1", [row.id, at, actorId]);
    const sums = trips.flatMap((trip) => trip.sums.map((sum) => ({ trip: ids.get(trip.number)!, ...sum })));
    // A client twice on one trip of the file is one sum.
    await db.query(
      `INSERT INTO trip_sums (trip_id, client_code, amount_micro, note)
       SELECT trip_id, client_code, SUM(amount_micro), string_agg(note, '; ')
         FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[]) AS line(trip_id, client_code, amount_micro, note)
        GROUP BY trip_id, client_code`,
      [sums.map((sum) => sum.trip), sums.map((sum) => sum.code), sums.map((sum) => sum.micro), sums.map((sum) => sum.note)],
    );

    // The payments of before are the file's, whole.
    await db.query("DELETE FROM past_payments");
    await db.query(
      `INSERT INTO past_payments (client_code, paid_day, amount_minor, kassa, note)
       SELECT * FROM unnest($1::text[], $2::date[], $3::bigint[], $4::text[], $5::text[])`,
      [payments.map((payment) => payment.code), payments.map((payment) => payment.day), payments.map((payment) => payment.minor), payments.map((payment) => payment.kassa), payments.map((payment) => payment.note)],
    );

    // The waybills of the trips on the road: a trip that has lines already is left as it is (loaded before, or written by hand since).
    const loaded: HistoryReport["waybills"] = [];
    for (const waybill of waybills) {
      const row = (await db.query<{ id: string; lines: string }>(
        "SELECT t.id, (SELECT count(*) FROM trip_cargo c WHERE c.trip_id = t.id AND c.deleted_at IS NULL) AS lines FROM trips t WHERE t.number = $1 AND t.deleted_at IS NULL",
        [waybill.number],
      )).rows[0];
      if (row && Number(row.lines) > 0) {
        loaded.push({ number: waybill.number, lines: 0, note: `left as it is: it has ${row.lines} lines already` });
        continue;
      }
      let tripId = row?.id;
      if (!tripId) {
        const header = {
          number: waybill.number,
          driverName: blank(waybill.driverName),
          driverPhone: blank(waybill.driverPhone),
          truckPlates: blank(waybill.truckPlates),
          direction: blank(waybill.direction),
          loadingDay: waybill.loadingDay ?? null,
          // A truck that is on the road left some day: the day it was loaded, when the file says no other.
          departureDay: waybill.departureDay ?? (waybill.status === "in_transit" ? (waybill.loadingDay ?? null) : null),
          status: waybill.status,
        };
        const made = await db.query<{ id: string }>(
          `INSERT INTO trips (number, driver_name, driver_phone, truck_plates, direction, loading_day, departure_day, status, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [header.number, header.driverName, header.driverPhone, header.truckPlates, header.direction, header.loadingDay, header.departureDay, header.status, actorId, at],
        );
        tripId = made.rows[0]!.id;
        await db.query("INSERT INTO trip_changes (trip_id, action, changed_at, changed_by, state_after) VALUES ($1, 'create', $2, $3, $4)", [tripId, at, actorId, JSON.stringify(header)]);
      }
      let count = 0;
      for (const [index, line] of waybill.lines.entries()) {
        const id = lineId(waybill.number, index);
        const fields = {
          warehouse: line.warehouse,
          truckPart: line.truckPart ?? null,
          acceptedDay: line.acceptedDay ?? null,
          clientCode: line.code,
          receiver: blank(line.receiver),
          sender: blank(line.sender),
          receiverPhone: blank(line.receiverPhone),
          item: blank(line.item),
          brand: blank(line.brand),
          size: blank(line.size),
          bags: line.bags ?? null,
          perBag: line.perBag ?? null,
          packaging: blank(line.packaging),
          pieces: line.pieces ?? null,
          weightG: line.weightG,
          priceMilli: line.priceMilli,
          note: null,
        };
        const inserted = await db.query(
          `INSERT INTO trip_cargo (id, trip_id, warehouse, client_code, sender, receiver_phone, item, brand, size, bags, per_bag, pieces,
                                   weight_g, price_milli, created_by, created_at, truck_part, accepted_day, receiver, packaging)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           ON CONFLICT (id) DO NOTHING`,
          [id, tripId, fields.warehouse, fields.clientCode, fields.sender, fields.receiverPhone, fields.item, fields.brand, fields.size, fields.bags, fields.perBag, fields.pieces, fields.weightG, fields.priceMilli, actorId, at, fields.truckPart, fields.acceptedDay, fields.receiver, fields.packaging],
        );
        if (inserted.rowCount === 1) {
          count++;
          await db.query("INSERT INTO trip_changes (trip_id, cargo_id, action, changed_at, changed_by, state_after) VALUES ($1, $2, 'add_cargo', $3, $4, $5)", [tripId, id, at, actorId, JSON.stringify(fields)]);
        }
      }
      loaded.push({ number: waybill.number, lines: count, note: row ? "its lines were added to the trip that was there" : "made" });
    }

    // What the debts come to now, month by month, next to what the card file said.
    const years = [...new Set([...trips.map((trip) => trip.arrivalDay.slice(0, 4)), ...payments.map((payment) => payment.day.slice(0, 4)), ...(file.control ?? []).map((month) => month.month.slice(0, 4))])].sort();
    const control: HistoryReport["control"] = [];
    for (const year of years) {
      for (const month of await readControl(db, clientCodes, Number(year))) control.push({ ...month, file: file.control?.find((item) => item.month === month.month) });
    }
    return {
      clients: { added, there: clients.length - added },
      trips: { added: tripsAdded, there: tripsThere, removed: gone.length, sums: sums.length },
      payments: payments.length,
      waybills: loaded,
      control,
    };
  });
}
