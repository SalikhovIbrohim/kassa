import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { SessionUser } from "./auth.js";
import type { Queryable } from "./balances.js";
import { centsOfMicro, centsOfMicroSql, readDebts, type ClientDebt } from "./client-debts.js";
import { clientCodeIn, type ClientCodes } from "./clients.js";
import { dayAverageRateSql, inTransaction } from "./ledger.js";
import { NO_NUL, NO_QUERY, UUID } from "./schemas.js";
import { cleanText } from "./text.js";
import type { Warehouse, Warehouses } from "./warehouses.js";

export type TripsOptions = {
  pool: pg.Pool;
  now: () => Date;
  /** The warehouses of the installation (WAREHOUSES). With none the business keeps no trips, and every route says so. */
  warehouses: Warehouses;
  /** How the business writes the codes of its clients: «А707» unless said. */
  clientCodes?: ClientCodes;
};

/** A truck is being loaded, then it is on the road, then it has arrived: from then on its cargo is owed. */
export type TripStatus = "loading" | "in_transit" | "arrived";
const STATUSES: readonly TripStatus[] = ["loading", "in_transit", "arrived"];

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_NUMBER = 999_999_999;
/** A thousand tonnes on one line, and a thousand dollars for a kilogram: far above any real cargo. */
const MAX_WEIGHT_G = 1_000_000_000;
const MAX_PRICE_MILLI = 1_000_000;

type TripRow = {
  id: string;
  number: number;
  driver_name: string | null;
  driver_phone: string | null;
  truck_plates: string | null;
  note: string | null;
  departure_day: string | null;
  arrival_day: string | null;
  status: TripStatus;
  lines: string;
  bags: string;
  weight_g: string;
  amount_minor: string;
};

/** A trip with what is on the truck: how many lines, bags and grams, and what they come to in cents. */
const TRIP_SELECT = `SELECT t.id, t.number, t.driver_name, t.driver_phone, t.truck_plates, t.note, t.status,
       to_char(t.departure_day, 'YYYY-MM-DD') AS departure_day, to_char(t.arrival_day, 'YYYY-MM-DD') AS arrival_day,
       COALESCE(s.lines, 0) AS lines, COALESCE(s.bags, 0) AS bags, COALESCE(s.weight_g, 0) AS weight_g, COALESCE(s.minor, 0) AS amount_minor
  FROM trips t
  LEFT JOIN (SELECT trip_id, count(*) AS lines, COALESCE(SUM(bags), 0) AS bags, SUM(weight_g) AS weight_g,
                    ${centsOfMicroSql("SUM(weight_g::numeric * price_milli)")} AS minor
               FROM trip_cargo WHERE deleted_at IS NULL GROUP BY trip_id) s ON s.trip_id = t.id`;

const toTrip = (row: TripRow) => ({
  number: row.number,
  driverName: row.driver_name,
  driverPhone: row.driver_phone,
  truckPlates: row.truck_plates,
  note: row.note,
  /** Days as YYYY-MM-DD. */
  departureDay: row.departure_day,
  arrivalDay: row.arrival_day,
  status: row.status,
  lines: Number(row.lines),
  bags: Number(row.bags),
  weightG: Number(row.weight_g),
  /** What the cargo comes to («Сумма в фуре»), in cents. */
  amountMinor: Number(row.amount_minor),
});

type CargoRow = {
  id: string;
  warehouse: Warehouse;
  client_code: string;
  client_name: string;
  sender: string | null;
  receiver_phone: string | null;
  item: string | null;
  brand: string | null;
  size: string | null;
  bags: number | null;
  per_bag: number | null;
  pieces: number | null;
  weight_g: string;
  price_milli: number;
  note: string | null;
  created_at: Date;
  author: string;
};

/** What a line of cargo says, as its history keeps it. */
type CargoState = {
  warehouse: Warehouse;
  clientCode: string;
  sender: string | null;
  receiverPhone: string | null;
  item: string | null;
  brand: string | null;
  size: string | null;
  bags: number | null;
  perBag: number | null;
  pieces: number | null;
  weightG: number;
  priceMilli: number;
  note: string | null;
};

const cargoState = (row: CargoRow): CargoState => ({
  warehouse: row.warehouse,
  clientCode: row.client_code,
  sender: row.sender,
  receiverPhone: row.receiver_phone,
  item: row.item,
  brand: row.brand,
  size: row.size,
  bags: row.bags,
  perBag: row.per_bag,
  pieces: row.pieces,
  weightG: Number(row.weight_g),
  priceMilli: row.price_milli,
  note: row.note,
});

const tripState = (row: TripRow) => ({
  number: row.number,
  driverName: row.driver_name,
  driverPhone: row.driver_phone,
  truckPlates: row.truck_plates,
  note: row.note,
  departureDay: row.departure_day,
  arrivalDay: row.arrival_day,
  status: row.status,
});

type CargoBody = {
  warehouse: Warehouse;
  clientCode: string;
  sender?: string | null;
  receiverPhone?: string | null;
  item?: string | null;
  brand?: string | null;
  size?: string | null;
  bags?: number | null;
  perBag?: number | null;
  pieces?: number | null;
  weightG: number;
  /** Without it, the price of the client. */
  priceMilli?: number;
  note?: string | null;
};

const text = (max: number) => ({ type: ["string", "null"], maxLength: max, pattern: NO_NUL }) as const;
const count = (max: number) => ({ type: ["integer", "null"], minimum: 0, maximum: max }) as const;
const DAY = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } as const;
const DAY_OR_NONE = { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } as const;
const NUMBER = { type: "integer", minimum: 1, maximum: MAX_NUMBER } as const;
const NUMBER_PARAM = { type: "object", required: ["number"], properties: { number: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } } } as const;
const CARGO_PARAMS = {
  type: "object",
  required: ["number", "id"],
  properties: { number: { type: "string", pattern: "^[1-9][0-9]{0,8}$" }, id: UUID },
} as const;

const headerProperties = {
  driverName: text(100),
  driverPhone: text(100),
  truckPlates: text(100),
  note: text(500),
  departureDay: DAY_OR_NONE,
} as const;

/** A day that the calendar has: 2026-02-30 is the shape of a day and is not one. */
function isDay(day: string): boolean {
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day;
}

/** The calendar day of Moscow an instant falls on: the trucks arrive there, and the business keeps its time. */
const moscowDay = (instant: Date) => new Date(instant.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const blankToNull = (value: string | null | undefined) => (value === undefined || value === null ? null : cleanText(value) || null);

const UNIQUE_VIOLATION = "23505";

/** A refusal with its HTTP status: what a change of a trip answers when it cannot be made. */
class Refusal {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}

/**
 * Groupage («Сборные грузы»): the trips of the business and the cargo on each. A trip is a truck; a line of its waybill
 * is the goods of one client, put on at one warehouse, by weight and by the price of a kilogram. When the trip has
 * arrived, its clients owe for their lines (see client-debts.ts).
 *
 * Who does what. The admin does everything, at any time. The keeper of a warehouse makes trips, keeps their headers,
 * sends them on their way and marks them arrived, and writes the cargo of their own warehouse until the trip has
 * arrived; one without a city writes the cargo of any warehouse. The owner looks. The cashiers do not come here: what
 * they need of it, the debt of a client, the directory of clients says.
 */
export async function registerTrips(app: FastifyInstance, options: TripsOptions) {
  const { pool, now, warehouses } = options;
  const codes = options.clientCodes ?? "letter";

  // The warehouses of the business, for the screens: none means there is no section «Сборные грузы» here.
  app.get("/api/warehouses", { onRequest: app.authenticate, config: { warehouse: true } }, async () => ({ warehouses: warehouses.list }));

  const enabled = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!warehouses.enabled) return reply.code(404).send({ error: "trips_disabled" });
  };
  const readers = [app.authenticate, enabled, app.requireRole("admin", "viewer", "warehouse")];
  const writers = [app.authenticate, enabled, app.requireRole("admin", "warehouse")];
  const adminOnly = [app.authenticate, enabled, app.requireRole("admin")];
  const config = { warehouse: true };

  const findTrip = async (db: Queryable, number: number, lock = false): Promise<TripRow | undefined> => {
    // Whoever changes a trip holds its row until they are done: a line cannot slip onto a truck while it is being
    // marked arrived, and two changes of one trip never mix.
    if (lock) await db.query("SELECT 1 FROM trips WHERE number = $1 AND deleted_at IS NULL FOR UPDATE", [number]);
    return (await db.query<TripRow>(`${TRIP_SELECT} WHERE t.number = $1 AND t.deleted_at IS NULL`, [number])).rows[0];
  };

  const readCargo = async (db: Queryable, tripId: string, id?: string): Promise<CargoRow[]> =>
    (
      await db.query<CargoRow>(
        `SELECT c.id, c.warehouse, c.client_code, cl.name AS client_name, c.sender, c.receiver_phone, c.item, c.brand, c.size,
                c.bags, c.per_bag, c.pieces, c.weight_g, c.price_milli, c.note, c.created_at, u.display_name AS author
           FROM trip_cargo c JOIN clients cl ON cl.code = c.client_code JOIN users u ON u.id = c.created_by
          WHERE c.trip_id = $1 AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR c.id = $2)
          ORDER BY c.position`,
        [tripId, id ?? null],
      )
    ).rows;

  const log = (db: Queryable, entry: { tripId: string; cargoId?: string; action: string; at: Date; by: string; before?: unknown; after?: unknown }) =>
    db.query(
      "INSERT INTO trip_changes (trip_id, cargo_id, action, changed_at, changed_by, state_before, state_after) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [entry.tripId, entry.cargoId ?? null, entry.action, entry.at, entry.by, entry.before === undefined ? null : JSON.stringify(entry.before), entry.after === undefined ? null : JSON.stringify(entry.after)],
    );

  /** Whether this person writes cargo onto this trip at all: the admin always, a keeper until the truck has arrived. */
  const writesCargo = (user: SessionUser, trip: TripRow) => user.role === "admin" || (user.role === "warehouse" && trip.status !== "arrived");
  /** Whether this person writes the cargo of this warehouse onto this trip. */
  const writesCargoOf = (user: SessionUser, trip: TripRow, warehouse: Warehouse) =>
    writesCargo(user, trip) && (user.role === "admin" ? true : warehouses.mayUse(user.city, warehouse));

  /**
   * A trip as its page shows it: the truck, the lines of its waybill, what each client has on it and owes in all, and
   * what this person may do with it. The owner and the admin also see what the cash desk spent on the trip.
   */
  const readDetail = async (db: Queryable, trip: TripRow, user: SessionUser) => {
    const rows = await readCargo(db, trip.id);
    const cargo = rows.map((row) => ({
      id: row.id,
      warehouse: row.warehouse,
      clientCode: row.client_code,
      clientName: row.client_name,
      sender: row.sender,
      receiverPhone: row.receiver_phone,
      item: row.item,
      brand: row.brand,
      size: row.size,
      bags: row.bags,
      perBag: row.per_bag,
      pieces: row.pieces,
      weightG: Number(row.weight_g),
      priceMilli: row.price_milli,
      /** What the line comes to, in cents (for reading: what is owed is rounded once for the client, see `clients`). */
      amountMinor: centsOfMicro(Number(row.weight_g) * row.price_milli),
      note: row.note,
      createdAt: row.created_at.toISOString(),
      author: row.author,
      /** This person may correct the line and take it off. */
      mine: writesCargoOf(user, trip, row.warehouse),
    }));

    // What each client has on the truck («жами»), and what they owe in all, the cash book counted in.
    const byClient = new Map<string, { code: string; name: string; bags: number; weightG: number; micro: number }>();
    for (const row of rows) {
      const sum = byClient.get(row.client_code) ?? { code: row.client_code, name: row.client_name, bags: 0, weightG: 0, micro: 0 };
      sum.bags += row.bags ?? 0;
      sum.weightG += Number(row.weight_g);
      sum.micro += Number(row.weight_g) * row.price_milli;
      byClient.set(row.client_code, sum);
    }
    const debts: Map<string, ClientDebt> = byClient.size > 0 ? await readDebts(db, codes, [...byClient.keys()]) : new Map();
    const order = (code: string) => Number(/[0-9]+/.exec(code)?.[0] ?? 0);
    const clients = [...byClient.values()]
      .sort((a, b) => order(a.code) - order(b.code) || a.code.localeCompare(b.code))
      .map((sum) => ({ code: sum.code, name: sum.name, bags: sum.bags, weightG: sum.weightG, amountMinor: centsOfMicro(sum.micro), debtMinor: debts.get(sum.code)?.debtMinor ?? 0 }));

    const admin = user.role === "admin";
    const keeper = user.role === "warehouse";
    const position = STATUSES.indexOf(trip.status);
    const may = {
      /** The header of the trip (the driver, the truck, the day it left). */
      edit: admin || (keeper && trip.status !== "arrived"),
      /** The warehouses whose cargo this person writes onto this trip. */
      warehouses: warehouses.ids.filter((id) => writesCargoOf(user, trip, id)),
      /** The next status this person may give the trip, and the one before (the admin takes a wrong step back). */
      forward: (admin || keeper) && position < STATUSES.length - 1 ? STATUSES[position + 1]! : null,
      back: admin && position > 0 ? STATUSES[position - 1]! : null,
      /** The number and the day of arrival are the admin's to put right; a trip without cargo is the admin's to take away. */
      admin,
      remove: admin && rows.length === 0,
    };

    // What the cash desk spent on this trip (its expenses that name the number), for those who see the money.
    let money: { expenseMinor: number; profitMinor: number } | undefined;
    if (admin || user.role === "viewer") {
      const spent = await db.query<{ minor: string | null }>(
        `SELECT SUM(CASE WHEN o.currency = 'USD' THEN o.amount_minor
                         WHEN r.rate IS NOT NULL THEN (2 * o.amount_minor * 10000 + r.rate) / (2 * r.rate) END) AS minor
           FROM operations o CROSS JOIN LATERAL (SELECT COALESCE(o.rate_e4, ${dayAverageRateSql("o")}) AS rate) r
          WHERE o.kind = 'expense' AND o.trip_number = $1 AND o.deleted_at IS NULL`,
        [trip.number],
      );
      const expenseMinor = Number(spent.rows[0]?.minor ?? 0);
      money = { expenseMinor, profitMinor: Number(trip.amount_minor) - expenseMinor };
    }
    return { trip: toTrip(trip), cargo, clients, may, ...(money ? { money } : {}) };
  };

  /** Runs a change of one trip in a transaction that holds the trip, and answers with the trip as it is afterwards. */
  async function change(
    request: FastifyRequest,
    reply: FastifyReply,
    number: number,
    work: (db: pg.PoolClient, trip: TripRow, at: Date) => Promise<{ status?: number; number?: number } | void>,
  ) {
    const user = request.user!;
    try {
      const done = await inTransaction(pool, async (db) => {
        const trip = await findTrip(db, number, true);
        if (!trip) throw new Refusal(404, "not_found");
        const result = (await work(db, trip, now())) ?? {};
        const after = await findTrip(db, result.number ?? number);
        if (!after) return { status: result.status ?? 200, body: { deleted: true } };
        return { status: result.status ?? 200, body: await readDetail(db, after, user) };
      });
      return reply.code(done.status).send(done.body);
    } catch (error) {
      if (error instanceof Refusal) return reply.code(error.status).send({ error: error.error });
      throw error;
    }
  }

  // The trips, the newest number first, with what is on each truck; and the number the next trip would have.
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    "/api/trips",
    {
      onRequest: readers,
      config,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "string", pattern: "^[0-9]{1,3}$" }, before: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } },
        },
      },
    },
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
      const found = await pool.query<TripRow>(
        `${TRIP_SELECT} WHERE t.deleted_at IS NULL AND ($1::int IS NULL OR t.number < $1) ORDER BY t.number DESC LIMIT $2`,
        [request.query.before === undefined ? null : Number(request.query.before), limit + 1],
      );
      const page = found.rows.slice(0, limit);
      const last = await pool.query<{ next: number }>("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM trips WHERE deleted_at IS NULL");
      return {
        trips: page.map(toTrip),
        nextBefore: found.rows.length > limit ? page[page.length - 1]!.number : null,
        nextNumber: Math.min(last.rows[0]!.next, MAX_NUMBER),
        // Whether this person makes trips: the screen shows «Новый рейс» to those.
        mayCreate: request.user!.role !== "viewer",
      };
    },
  );

  app.post<{ Body: { number: number; driverName?: string | null; driverPhone?: string | null; truckPlates?: string | null; note?: string | null; departureDay?: string | null } }>(
    "/api/trips",
    {
      onRequest: writers,
      config,
      schema: {
        querystring: NO_QUERY,
        body: { type: "object", required: ["number"], additionalProperties: false, properties: { number: NUMBER, ...headerProperties } },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.departureDay && !isDay(body.departureDay)) return reply.code(400).send({ error: "bad_day" });
      const user = request.user!;
      try {
        const made = await inTransaction(pool, async (db) => {
          const at = now();
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO trips (number, driver_name, driver_phone, truck_plates, note, departure_day, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [body.number, blankToNull(body.driverName), blankToNull(body.driverPhone), blankToNull(body.truckPlates), blankToNull(body.note), body.departureDay ?? null, user.id, at],
          );
          const trip = (await findTrip(db, body.number))!;
          await log(db, { tripId: inserted.rows[0]!.id, action: "create", at, by: user.id, after: tripState(trip) });
          return readDetail(db, trip, user);
        });
        return reply.code(201).send(made);
      } catch (error) {
        // One trip to a number: the screen says so and offers the next one.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return reply.code(409).send({ error: "trip_exists" });
        throw error;
      }
    },
  );

  app.get<{ Params: { number: string } }>("/api/trips/:number", { onRequest: readers, config, schema: { params: NUMBER_PARAM, querystring: NO_QUERY } }, async (request, reply) => {
    // One snapshot: the lines, the sums and the debts are of one moment.
    const detail = await inTransaction(
      pool,
      async (db) => {
        const trip = await findTrip(db, Number(request.params.number));
        return trip ? readDetail(db, trip, request.user!) : undefined;
      },
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    if (!detail) return reply.code(404).send({ error: "not_found" });
    return detail;
  });

  // The header of a trip. The number and the day of arrival are the admin's to put right: the entries of the cash desk
  // name the trip by its number, and the day of arrival is the day the cargo is owed from.
  app.patch<{ Params: { number: string }; Body: { number?: number; driverName?: string | null; driverPhone?: string | null; truckPlates?: string | null; note?: string | null; departureDay?: string | null; arrivalDay?: string } }>(
    "/api/trips/:number",
    {
      onRequest: writers,
      config,
      schema: {
        params: NUMBER_PARAM,
        querystring: NO_QUERY,
        body: { type: "object", additionalProperties: false, minProperties: 1, properties: { number: NUMBER, ...headerProperties, arrivalDay: DAY } },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const user = request.user!;
      for (const day of [body.departureDay, body.arrivalDay]) if (day && !isDay(day)) return reply.code(400).send({ error: "bad_day" });
      if ((body.number !== undefined || body.arrivalDay !== undefined) && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      try {
        return await change(request, reply, Number(request.params.number), async (db, trip, at) => {
          if (user.role !== "admin" && trip.status === "arrived") throw new Refusal(409, "trip_arrived");
          if (body.arrivalDay !== undefined && trip.status !== "arrived") throw new Refusal(409, "not_arrived");
          const kept = <T>(sent: T | undefined, stored: T) => (sent === undefined ? stored : sent);
          const next = {
            number: body.number ?? trip.number,
            driverName: body.driverName === undefined ? trip.driver_name : blankToNull(body.driverName),
            driverPhone: body.driverPhone === undefined ? trip.driver_phone : blankToNull(body.driverPhone),
            truckPlates: body.truckPlates === undefined ? trip.truck_plates : blankToNull(body.truckPlates),
            note: body.note === undefined ? trip.note : blankToNull(body.note),
            departureDay: kept(body.departureDay, trip.departure_day),
            arrivalDay: kept(body.arrivalDay, trip.arrival_day),
          };
          const before = tripState(trip);
          const after = { ...before, ...next };
          if (JSON.stringify(before) === JSON.stringify(after)) return;
          await db.query(
            "UPDATE trips SET number = $2, driver_name = $3, driver_phone = $4, truck_plates = $5, note = $6, departure_day = $7, arrival_day = $8 WHERE id = $1",
            [trip.id, next.number, next.driverName, next.driverPhone, next.truckPlates, next.note, next.departureDay, next.arrivalDay],
          );
          await log(db, { tripId: trip.id, action: "edit", at, by: user.id, before, after });
          return { number: next.number };
        });
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return reply.code(409).send({ error: "trip_exists" });
        throw error;
      }
    },
  );

  // The truck left («Фура выехала»), the truck arrived («Рейс прибыл», with the day: from then on its cargo is owed).
  // One step at a time. A step back is the admin's, for a step taken by mistake; so is another day of arrival.
  app.post<{ Params: { number: string }; Body: { status: TripStatus; arrivalDay?: string } }>(
    "/api/trips/:number/status",
    {
      onRequest: writers,
      config,
      schema: {
        params: NUMBER_PARAM,
        querystring: NO_QUERY,
        body: { type: "object", required: ["status"], additionalProperties: false, properties: { status: { type: "string", enum: [...STATUSES] }, arrivalDay: DAY } },
      },
    },
    async (request, reply) => {
      const { status, arrivalDay } = request.body;
      const user = request.user!;
      if (arrivalDay !== undefined && (status !== "arrived" || !isDay(arrivalDay))) return reply.code(400).send({ error: "bad_day" });
      return change(request, reply, Number(request.params.number), async (db, trip, at) => {
        const step = STATUSES.indexOf(status) - STATUSES.indexOf(trip.status);
        const sameDay = arrivalDay === undefined || arrivalDay === trip.arrival_day;
        // Asked again for what is so already (an answer that was lost): nothing to do.
        if (step === 0 && sameDay) return;
        if (step === 0 && user.role !== "admin") throw new Refusal(403, "forbidden");
        if (step > 1 || step < -1) throw new Refusal(409, "wrong_status");
        if (step < 0 && user.role !== "admin") throw new Refusal(403, "forbidden");
        if (status === "arrived" && step === 1 && arrivalDay === undefined) throw new Refusal(400, "arrival_day_required");
        const day = status === "arrived" ? (arrivalDay ?? trip.arrival_day) : null;
        // A truck that is on its way left some day: today, when nobody said which.
        const departure = trip.departure_day ?? (status === "loading" ? null : moscowDay(at));
        if (day !== null && departure !== null && day < departure) throw new Refusal(400, "arrival_before_departure");
        const before = tripState(trip);
        await db.query("UPDATE trips SET status = $2, arrival_day = $3, departure_day = $4 WHERE id = $1", [trip.id, status, day, departure]);
        await log(db, { tripId: trip.id, action: "status", at, by: user.id, before, after: { ...before, status, arrivalDay: day, departureDay: departure } });
      });
    },
  );

  // A trip made by mistake: the admin takes it away while there is no cargo on it. Its number is free again.
  app.delete<{ Params: { number: string } }>("/api/trips/:number", { onRequest: adminOnly, config, schema: { params: NUMBER_PARAM, querystring: NO_QUERY } }, async (request, reply) =>
    change(request, reply, Number(request.params.number), async (db, trip, at) => {
      if (Number(trip.lines) > 0) throw new Refusal(409, "trip_has_cargo");
      await db.query("UPDATE trips SET deleted_at = $2, deleted_by = $3 WHERE id = $1", [trip.id, at, request.user!.id]);
      await log(db, { tripId: trip.id, action: "delete", at, by: request.user!.id, before: tripState(trip) });
    }),
  );

  const cargoProperties = {
    // Whether it is a warehouse of the business is looked at with who may write its cargo (see `cargoFields`).
    warehouse: { type: "string", minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9_]*$" },
    clientCode: { type: "string", minLength: 1, maxLength: 64, pattern: NO_NUL },
    sender: text(100),
    receiverPhone: text(100),
    item: text(200),
    brand: text(100),
    size: text(50),
    bags: count(1_000_000),
    perBag: count(1_000_000),
    pieces: count(1_000_000_000),
    weightG: { type: "integer", minimum: 1, maximum: MAX_WEIGHT_G },
    priceMilli: { type: "integer", minimum: 0, maximum: MAX_PRICE_MILLI },
    note: text(500),
  } as const;

  /**
   * What a line is to say, checked: the warehouse is one of the business and this person's to write, the client is one
   * of the directory (a line that is corrected may keep the client it has, switched off since or not), and the price
   * is the one sent or the client's own.
   */
  async function cargoFields(db: Queryable, user: SessionUser, trip: TripRow, body: CargoBody, stored?: CargoRow): Promise<CargoState> {
    if (!writesCargo(user, trip)) throw new Refusal(409, "trip_arrived");
    if (!warehouses.has(body.warehouse)) throw new Refusal(400, "bad_warehouse");
    if (!writesCargoOf(user, trip, body.warehouse) || (stored && !writesCargoOf(user, trip, stored.warehouse))) throw new Refusal(403, "warehouse_forbidden");
    const code = clientCodeIn(body.clientCode, codes);
    const client = code ? (await db.query<{ code: string; active: boolean; price_milli: number | null }>("SELECT code, active, price_milli FROM clients WHERE code = $1", [code])).rows[0] : undefined;
    if (!client || (!client.active && client.code !== stored?.client_code)) throw new Refusal(400, "unknown_client");
    const priceMilli = body.priceMilli ?? client.price_milli;
    if (priceMilli === null || priceMilli === undefined) throw new Refusal(400, "price_required");
    return {
      warehouse: body.warehouse,
      clientCode: client.code,
      sender: blankToNull(body.sender),
      receiverPhone: blankToNull(body.receiverPhone),
      item: blankToNull(body.item),
      brand: blankToNull(body.brand),
      size: blankToNull(body.size),
      bags: body.bags ?? null,
      perBag: body.perBag ?? null,
      pieces: body.pieces ?? null,
      weightG: body.weightG,
      priceMilli,
      note: blankToNull(body.note),
    };
  }

  // A line onto the waybill. Its id is made by the screen: the same line sent twice (an answer that was lost) is
  // stored once.
  app.post<{ Params: { number: string }; Body: CargoBody & { id: string } }>(
    "/api/trips/:number/cargo",
    {
      onRequest: writers,
      config,
      schema: {
        params: NUMBER_PARAM,
        querystring: NO_QUERY,
        body: { type: "object", required: ["id", "warehouse", "clientCode", "weightG"], additionalProperties: false, properties: { id: UUID, ...cargoProperties } },
      },
    },
    async (request, reply) => {
      const { id, ...body } = request.body;
      const user = request.user!;
      return change(request, reply, Number(request.params.number), async (db, trip, at) => {
        const there = await db.query<{ trip_id: string; deleted_at: Date | null }>("SELECT trip_id, deleted_at FROM trip_cargo WHERE id = $1", [id]);
        if (there.rows[0]) {
          if (there.rows[0].trip_id !== trip.id || there.rows[0].deleted_at) throw new Refusal(409, "cargo_id_conflict");
          return;
        }
        const fields = await cargoFields(db, user, trip, body);
        await db.query(
          `INSERT INTO trip_cargo (id, trip_id, warehouse, client_code, sender, receiver_phone, item, brand, size, bags, per_bag, pieces,
                                   weight_g, price_milli, note, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [id, trip.id, fields.warehouse, fields.clientCode, fields.sender, fields.receiverPhone, fields.item, fields.brand, fields.size, fields.bags, fields.perBag, fields.pieces, fields.weightG, fields.priceMilli, fields.note, user.id, at],
        );
        await log(db, { tripId: trip.id, cargoId: id, action: "add_cargo", at, by: user.id, after: fields });
        return { status: 201 };
      });
    },
  );

  app.put<{ Params: { number: string; id: string }; Body: CargoBody }>(
    "/api/trips/:number/cargo/:id",
    {
      onRequest: writers,
      config,
      schema: {
        params: CARGO_PARAMS,
        querystring: NO_QUERY,
        body: { type: "object", required: ["warehouse", "clientCode", "weightG"], additionalProperties: false, properties: cargoProperties },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      return change(request, reply, Number(request.params.number), async (db, trip, at) => {
        const stored = (await readCargo(db, trip.id, request.params.id))[0];
        if (!stored) throw new Refusal(404, "not_found");
        const before = cargoState(stored);
        // A correction that says no price keeps the one the line has, not the client's of today.
        const after = await cargoFields(db, user, trip, { ...request.body, priceMilli: request.body.priceMilli ?? before.priceMilli }, stored);
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        await db.query(
          `UPDATE trip_cargo SET warehouse = $2, client_code = $3, sender = $4, receiver_phone = $5, item = $6, brand = $7, size = $8,
                  bags = $9, per_bag = $10, pieces = $11, weight_g = $12, price_milli = $13, note = $14
            WHERE id = $1`,
          [stored.id, after.warehouse, after.clientCode, after.sender, after.receiverPhone, after.item, after.brand, after.size, after.bags, after.perBag, after.pieces, after.weightG, after.priceMilli, after.note],
        );
        await log(db, { tripId: trip.id, cargoId: stored.id, action: "edit_cargo", at, by: user.id, before, after });
      });
    },
  );

  // A line off the waybill: hidden, never erased. Asked again, there is nothing more to take off.
  app.delete<{ Params: { number: string; id: string } }>("/api/trips/:number/cargo/:id", { onRequest: writers, config, schema: { params: CARGO_PARAMS, querystring: NO_QUERY } }, async (request, reply) => {
    const user = request.user!;
    return change(request, reply, Number(request.params.number), async (db, trip, at) => {
      const stored = (await readCargo(db, trip.id, request.params.id))[0];
      if (!stored) {
        const gone = await db.query("SELECT 1 FROM trip_cargo WHERE id = $1 AND trip_id = $2", [request.params.id, trip.id]);
        if (gone.rowCount === 0) throw new Refusal(404, "not_found");
        return;
      }
      if (!writesCargo(user, trip)) throw new Refusal(409, "trip_arrived");
      if (!writesCargoOf(user, trip, stored.warehouse)) throw new Refusal(403, "warehouse_forbidden");
      await db.query("UPDATE trip_cargo SET deleted_at = $2, deleted_by = $3 WHERE id = $1", [stored.id, at, user.id]);
      await log(db, { tripId: trip.id, cargoId: stored.id, action: "delete_cargo", at, by: user.id, before: cargoState(stored) });
    });
  });

  // What was done to a trip and to its lines, oldest first: for the owner and the admin.
  app.get<{ Params: { number: string } }>(
    "/api/trips/:number/history",
    { onRequest: [app.authenticate, enabled, app.requireRole("admin", "viewer")], schema: { params: NUMBER_PARAM, querystring: NO_QUERY } },
    async (request, reply) => {
      const trip = await findTrip(pool, Number(request.params.number));
      if (!trip) return reply.code(404).send({ error: "not_found" });
      const lines = await pool.query<{ action: string; cargo_id: string | null; changed_at: Date; login: string; display_name: string; state_before: unknown; state_after: unknown }>(
        `SELECT h.action, h.cargo_id, h.changed_at, u.login, u.display_name, h.state_before, h.state_after
           FROM trip_changes h JOIN users u ON u.id = h.changed_by WHERE h.trip_id = $1 ORDER BY h.id`,
        [trip.id],
      );
      return {
        changes: lines.rows.map((line) => ({
          action: line.action,
          cargoId: line.cargo_id,
          at: line.changed_at.toISOString(),
          by: { login: line.login, displayName: line.display_name },
          before: line.state_before,
          after: line.state_after,
        })),
      };
    },
  );
}
