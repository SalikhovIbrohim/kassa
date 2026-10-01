import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances, type Balance, type Queryable } from "./balances.js";
import { inTransaction, lockBalances } from "./ledger.js";
import { CURRENCIES, type Currency } from "./money.js";
import { UUID } from "./schemas.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** The largest cash count accepted, in minor units: far above any real cash desk, far below what a number holds exactly. */
const MAX_COUNTED_MINOR = 1_000_000_000_000_000;

export type ShiftsOptions = {
  pool: pg.Pool;
  now: () => Date;
};

export type ShiftView = {
  id: string;
  openedAt: string;
  cashier: { login: string; displayName: string };
  /** What the shift started with, each currency; the cash desk at that moment, or what was counted at the end of the shift before. */
  openingBalances: Balance[];
};

/** The shift that is open now, if any. At most one is: the database sees to it. */
export async function currentShift(db: Queryable): Promise<ShiftView | null> {
  const found = await db.query<{ id: string; opened_at: Date; login: string; display_name: string }>(
    `SELECT s.id, s.opened_at, u.login, u.display_name
       FROM shifts s JOIN users u ON u.id = s.cashier_id
      WHERE s.closed_at IS NULL`,
  );
  const row = found.rows[0];
  if (!row) return null;
  const balances = await db.query<{ currency: Currency; opening_minor: string }>(
    "SELECT currency, opening_minor FROM shift_balances WHERE shift_id = $1",
    [row.id],
  );
  const opening = new Map(balances.rows.map((item) => [item.currency, Number(item.opening_minor)]));
  return {
    id: row.id,
    openedAt: row.opened_at.toISOString(),
    cashier: { login: row.login, displayName: row.display_name },
    openingBalances: CURRENCIES.map((currency) => ({ currency, amountMinor: opening.get(currency) ?? 0 })),
  };
}

type Person = { login: string; displayName: string };

/** A shift as the owner reads it: who, when, and per currency what it started with and how the count came out. */
export type ShiftReport = {
  id: string;
  openedAt: string;
  /** Null while the shift is open. */
  closedAt: string | null;
  cashier: Person;
  closedBy: Person | null;
  currencies: Array<{
    currency: Currency;
    openingMinor: number;
    /** What the books said at the end of the shift, what was counted, and the difference (counted minus books). Null while open. */
    calculatedMinor: number | null;
    actualMinor: number | null;
    differenceMinor: number | null;
  }>;
};

type ReportRow = {
  id: string;
  opened_at: Date;
  closed_at: Date | null;
  login: string;
  display_name: string;
  closed_login: string | null;
  closed_display_name: string | null;
};

const REPORT_SELECT = `SELECT s.id, s.opened_at, s.closed_at, u.login, u.display_name,
       cb.login AS closed_login, cb.display_name AS closed_display_name
  FROM shifts s
  JOIN users u ON u.id = s.cashier_id
  LEFT JOIN users cb ON cb.id = s.closed_by`;

/** Reads the shifts that `where` picks (newest first), with their figures. */
async function readReports(db: Queryable, where: string, params: unknown[], limit: number): Promise<ShiftReport[]> {
  const found = await db.query<ReportRow>(
    `${REPORT_SELECT} ${where} ORDER BY s.opened_at DESC, s.id DESC LIMIT ${limit}`,
    params,
  );
  if (found.rows.length === 0) return [];
  const figures = await db.query<{
    shift_id: string;
    currency: Currency;
    opening_minor: string;
    calculated_minor: string | null;
    actual_minor: string | null;
    difference_minor: string | null;
  }>("SELECT * FROM shift_balances WHERE shift_id = ANY($1::uuid[])", [found.rows.map((row) => row.id)]);
  const number = (value: string | null) => (value === null ? null : Number(value));
  return found.rows.map((row) => ({
    id: row.id,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    cashier: { login: row.login, displayName: row.display_name },
    closedBy: row.closed_login === null ? null : { login: row.closed_login, displayName: row.closed_display_name ?? row.closed_login },
    currencies: CURRENCIES.map((currency) => {
      const figure = figures.rows.find((item) => item.shift_id === row.id && item.currency === currency);
      return {
        currency,
        openingMinor: Number(figure?.opening_minor ?? 0),
        calculatedMinor: number(figure?.calculated_minor ?? null),
        actualMinor: number(figure?.actual_minor ?? null),
        differenceMinor: number(figure?.difference_minor ?? null),
      };
    }),
  }));
}

export type CloseResult =
  | { status: "closed" | "replayed"; shift: ShiftReport }
  | { status: "not_found" }
  /** The shift is somebody else's. */
  | { status: "not_yours" }
  /** It was closed before, with another count than the one now sent. */
  | { status: "already_closed"; shift: ShiftReport };

/**
 * Closes a shift with the count of the cash. For each currency the books say what the cash desk should hold
 * (everything entered, plus what earlier counts found), the cashier says what is really there, and the
 * difference is kept with the shift, in the name of the cashier. From then on the books say what was counted.
 * The cash desk's balances are held still meanwhile, so that no expense slips in between the two figures.
 * Sending the same count again answers as before: a lost answer does not make the shift unclosable.
 */
export async function closeShift(
  pool: pg.Pool,
  request: { shiftId: string; closerId: string; counted: Balance[]; now: Date },
): Promise<CloseResult> {
  return inTransaction(pool, async (client): Promise<CloseResult> => {
    await lockBalances(client, CURRENCIES);
    const found = await client.query<{ cashier_id: string; closed_at: Date | null }>(
      "SELECT cashier_id, closed_at FROM shifts WHERE id = $1 FOR UPDATE",
      [request.shiftId],
    );
    const shift = found.rows[0];
    if (!shift) return { status: "not_found" };
    if (shift.cashier_id !== request.closerId) return { status: "not_yours" };

    if (shift.closed_at) {
      const [report] = await readReports(client, "WHERE s.id = $1", [request.shiftId], 1);
      if (!report) throw new Error(`Shift ${request.shiftId} is closed and not there`);
      const same = request.counted.every(
        (item) => report.currencies.find((figure) => figure.currency === item.currency)?.actualMinor === item.amountMinor,
      );
      return { status: same ? "replayed" : "already_closed", shift: report };
    }

    const books = await getBalances(client);
    for (const { currency, amountMinor: counted } of request.counted) {
      const calculated = books.find((item) => item.currency === currency)?.amountMinor ?? 0;
      const updated = await client.query(
        `UPDATE shift_balances SET calculated_minor = $3::bigint, actual_minor = $4::bigint, difference_minor = $4::bigint - $3::bigint
          WHERE shift_id = $1 AND currency = $2`,
        [request.shiftId, currency, calculated, counted],
      );
      if (updated.rowCount !== 1) throw new Error(`Shift ${request.shiftId} has no figures for ${currency}`);
    }
    await client.query("UPDATE shifts SET closed_at = $2, closed_by = $3 WHERE id = $1", [
      request.shiftId,
      request.now,
      request.closerId,
    ]);
    const [report] = await readReports(client, "WHERE s.id = $1", [request.shiftId], 1);
    if (!report) throw new Error(`Shift ${request.shiftId} was closed and is not there`);
    return { status: "closed", shift: report };
  });
}

/**
 * What a shift that opens now starts with: what was counted at the end of the shift that closed last, and
 * for a currency with no such count (the first shift ever) what the books say at this moment.
 */
async function openingBalancesNow(db: Queryable): Promise<Balance[]> {
  const books = await getBalances(db);
  const counted = await db.query<{ currency: Currency; actual_minor: string }>(
    `SELECT currency, actual_minor
       FROM shift_balances
      WHERE actual_minor IS NOT NULL
        AND shift_id = (SELECT id FROM shifts WHERE closed_at IS NOT NULL ORDER BY closed_at DESC, opened_at DESC LIMIT 1)`,
  );
  const actual = new Map(counted.rows.map((item) => [item.currency, Number(item.actual_minor)]));
  return books.map((balance) => ({ currency: balance.currency, amountMinor: actual.get(balance.currency) ?? balance.amountMinor }));
}

export async function registerShifts(app: FastifyInstance, options: ShiftsOptions) {
  const { pool, now } = options;

  // The owner reads the shifts: who worked, when, and how the count of the cash came out. Newest first.
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    "/api/shifts",
    {
      onRequest: [app.authenticate, app.requireRole("viewer")],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string", pattern: "^[0-9]{1,3}$" },
            // Where the previous page ended: the time the last shift of it was opened.
            before: { type: "string", format: "date-time", maxLength: 40 },
          },
        },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(request.query.limit);
      if (limit < 1 || limit > MAX_PAGE_SIZE) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: `querystring/limit must be from 1 to ${MAX_PAGE_SIZE}` });
      }
      const before = request.query.before === undefined ? null : new Date(request.query.before);
      const rows = await readReports(pool, before ? "WHERE s.opened_at < $1" : "", before ? [before] : [], limit + 1);
      const shifts = rows.slice(0, limit);
      const last = shifts.at(-1);
      return { shifts, nextBefore: rows.length > limit && last ? last.openedAt : null };
    },
  );

  // Anyone signed in may look: the cashier to see whether to open one, the owner to see who is working.
  app.get("/api/shifts/current", { onRequest: app.authenticate }, async () => ({ shift: await currentShift(pool) }));

  // A cashier opens a shift. Only one is open at a time in the whole cash desk.
  app.post("/api/shifts", { onRequest: [app.authenticate, app.requireRole("cashier")] }, async (request, reply) => {
    const opened = await inTransaction(pool, async (client): Promise<{ shift: ShiftView } | { already: ShiftView | null }> => {
      const existing = await currentShift(client);
      if (existing) return { already: existing };

      const opening = await openingBalancesNow(client);
      // Two cashiers can get here together: the unique index lets one of them in, and the other
      // inserts nothing (its transaction waited for the first to finish).
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO shifts (cashier_id, opened_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        [request.user!.id, now()],
      );
      const id = inserted.rows[0]?.id;
      if (!id) return { already: await currentShift(client) };

      for (const balance of opening) {
        await client.query("INSERT INTO shift_balances (shift_id, currency, opening_minor) VALUES ($1, $2, $3)", [
          id,
          balance.currency,
          balance.amountMinor,
        ]);
      }
      const shift = await currentShift(client);
      if (!shift) throw new Error(`Shift ${id} was opened and is not there`);
      return { shift };
    });

    if ("shift" in opened) return reply.code(201).send({ shift: opened.shift });
    return reply.code(409).send({
      error: "shift_already_open",
      message: "A shift is open already: only one shift can be open at a time.",
      shift: opened.already,
    });
  });

  // A cashier closes their own shift with the count of the cash, one amount per currency.
  app.post<{ Params: { id: string }; Body: { counted: Balance[] } }>(
    "/api/shifts/:id/close",
    {
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        params: { type: "object", required: ["id"], properties: { id: UUID } },
        body: {
          type: "object",
          required: ["counted"],
          additionalProperties: false,
          properties: {
            counted: {
              type: "array",
              minItems: CURRENCIES.length,
              maxItems: CURRENCIES.length,
              items: {
                type: "object",
                required: ["currency", "amountMinor"],
                additionalProperties: false,
                properties: {
                  currency: { type: "string", enum: [...CURRENCIES] },
                  amountMinor: { type: "integer", minimum: 0, maximum: MAX_COUNTED_MINOR },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { counted } = request.body;
      if (new Set(counted.map((item) => item.currency)).size !== CURRENCIES.length) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/counted must name each currency once" });
      }
      const result = await closeShift(pool, {
        shiftId: request.params.id,
        closerId: request.user!.id,
        counted,
        now: now(),
      });
      switch (result.status) {
        case "closed":
        case "replayed":
          return { shift: result.shift };
        case "not_found":
          return reply.code(404).send({ error: "shift_not_found" });
        case "not_yours":
          return reply.code(403).send({ error: "not_your_shift", message: "Only the cashier who opened a shift can close it." });
        case "already_closed":
          return reply.code(409).send({ error: "shift_already_closed", shift: result.shift });
      }
    },
  );
}
