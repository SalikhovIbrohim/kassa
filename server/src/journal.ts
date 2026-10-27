import { kassaProperty, mayUseKassa, type Kassa } from "./kassa.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { cashDayEnd, cashDayOf, cashDayStart } from "./cash-day.js";
import { OPERATION_FROM, OPERATION_SELECT, toOperation, type OperationRow } from "./ledger.js";
import { CURRENCIES } from "./money.js";
import { NO_NUL } from "./schemas.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type JournalOptions = {
  pool: pg.Pool;
  now: () => Date;
};

type JournalQuery = {
  from?: string;
  to?: string;
  currency?: string;
  type?: string;
  category?: string;
  clientCode?: string;
  author?: string;
  kassa?: Kassa;
  deleted?: "exclude" | "include" | "only";
  onec?: OneCFilter;
  limit?: string;
  cursor?: string;
};

/** The admin's filter on the column «1С»: written, waiting for its turn, waiting for a person or failed, never sent. */
type OneCFilter = "written" | "waiting" | "problem" | "none";

const ONEC_CONDITION: Record<OneCFilter, string> = {
  written: "ob.status = 'written'",
  waiting: "ob.status = 'pending'",
  problem: "ob.status IN ('blocked', 'failed')",
  none: "ob.id IS NULL",
};

type OneCRow = { onec_id: string | null; onec_status: string | null; onec_doc_number: string | null; onec_detail: string | null; onec_attempts: number | null };

/** What became of an entry in 1C, for the admin: null when it never went into the queue of 1C. */
function oneCOf(row: OneCRow) {
  if (row.onec_id === null) return null;
  return { id: Number(row.onec_id), status: row.onec_status, docNumber: row.onec_doc_number, detail: row.onec_detail, attempts: row.onec_attempts };
}

/**
 * Where the previous page ended: the newest-first order is (created_at, id). The time is
 * kept as text with the full microseconds PostgreSQL stores, never squeezed through a
 * JavaScript Date, which would round it to milliseconds and skip rows in between.
 */
type Position = { createdAt: string; id: string };

const CURSOR_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`);
// Nothing this application records is older or newer; a cursor outside is not one of ours.
const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

/** Opaque to clients: they only hand back what they were given. */
function encodeCursor(position: Position): string {
  return Buffer.from(`${position.createdAt}|${position.id}`).toString("base64url");
}

/** Strict: anything that is not exactly what encodeCursor makes is rejected, never passed on to SQL. */
function decodeCursor(cursor: string): Position | null {
  const [createdAt, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !createdAt || !id || !UUID.test(id)) return null;
  const match = CURSOR_TIME.exec(createdAt);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < EARLIEST_YEAR || year >= LATEST_YEAR) return null;
  // A day that does not exist (30 February) comes back from Date as another day.
  const date = new Date(`${createdAt.slice(0, 19)}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== createdAt.slice(0, 19)) return null;
  return { createdAt, id };
}

export async function registerJournal(app: FastifyInstance, options: JournalOptions) {
  const { pool, now } = options;

  // The journal: newest first, one page at a time. Everybody who works in the cash desk sees everybody's entries (it is
  // one book and one box of money, and each line says who entered it); only the owner and the admin see the deleted ones.
  // Everything else is a filter on top of that.
  app.get<{ Querystring: JournalQuery }>(
    "/api/operations",
    {
      onRequest: app.authenticate,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            currency: { type: "string", enum: [...CURRENCIES] },
            type: { type: "string", enum: ["income", "expense"] },
            category: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9_]+$" },
            clientCode: { type: "string", minLength: 1, maxLength: 64, pattern: NO_NUL },
            author: { type: "string", minLength: 1, maxLength: 64, pattern: NO_NUL },
            // One cash desk; without it, the person's own, or both for a person of everywhere.
            kassa: kassaProperty,
            // Deleted operations: left out (the default), shown among the others, or only them.
            deleted: { type: "string", enum: ["exclude", "include", "only"] },
            // The admin's: what became of the entries in 1C.
            onec: { type: "string", enum: ["written", "waiting", "problem", "none"] },
            // Query strings arrive as text and this server does not guess types.
            limit: { type: "string", pattern: "^[0-9]{1,3}$" },
            cursor: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;
      const user = request.user!;
      const badRequest = (message: string) =>
        reply.code(400).send({ statusCode: 400, error: "Bad Request", message });

      // One bound on its own means that single day; neither means today (the day of the cash desk, see cash-day.ts).
      const from = query.from ?? query.to ?? cashDayOf(now());
      const to = query.to ?? query.from ?? from;
      if (from > to) return badRequest("querystring/from must not be after querystring/to");

      const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
      if (limit < 1 || limit > MAX_PAGE_SIZE) {
        return badRequest(`querystring/limit must be from 1 to ${MAX_PAGE_SIZE}`);
      }

      let position: Position | null = null;
      if (query.cursor !== undefined) {
        position = decodeCursor(query.cursor);
        if (!position) return badRequest("querystring/cursor is not a cursor this server gave out");
      }

      // A deleted operation disappears for cashiers; only the owner and the admin can look at them.
      const deleted = query.deleted ?? "exclude";
      if ((user.role === "cashier" || user.role === "head_cashier") && deleted !== "exclude") {
        return reply.code(403).send({ error: "forbidden" });
      }

      // The column «1С» is the admin's: he is the one who decides what to do with a payment 1C did not take.
      const admin = user.role === "admin";
      if (query.onec !== undefined && !admin) return reply.code(403).send({ error: "forbidden" });

      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (condition: (placeholder: string) => string, value: unknown) => {
        values.push(value);
        conditions.push(condition(`$${values.length}`));
      };
      add((p) => `o.created_at >= ${p}`, cashDayStart(from));
      add((p) => `o.created_at < ${p}`, cashDayEnd(to));
      if (deleted === "exclude") conditions.push("o.deleted_at IS NULL");
      if (deleted === "only") conditions.push("o.deleted_at IS NOT NULL");

      // lower() on both sides: the database folds case its own way, and so must the typed text.
      if (query.author !== undefined) add((p) => `lower(u.login) = lower(${p})`, query.author);
      const kassa = query.kassa ?? user.city ?? undefined;
      if (kassa !== undefined && !mayUseKassa(user.city, kassa)) return reply.code(403).send({ error: "kassa_forbidden" });
      if (kassa !== undefined) add((p) => `o.kassa = ${p}`, kassa);
      if (query.currency !== undefined) add((p) => `o.currency = ${p}`, query.currency);
      if (query.type !== undefined) add((p) => `o.kind = ${p}`, query.type);
      if (query.category !== undefined) add((p) => `o.category = ${p}`, query.category);
      // The whole code, compared on the lower-cased key: no pattern, so % and _ are just characters.
      if (query.clientCode !== undefined) add((p) => `o.client_code_key = ${p}`, query.clientCode.trim().toLowerCase());
      if (query.onec !== undefined) conditions.push(ONEC_CONDITION[query.onec]);
      if (position) {
        values.push(position.createdAt, position.id);
        conditions.push(`(o.created_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);

      const found = await pool.query<OperationRow & OneCRow & { created_at_cursor: string }>(
        `SELECT ${OPERATION_SELECT},
                ${admin ? "ob.id AS onec_id, ob.status AS onec_status, ob.doc_number AS onec_doc_number, ob.detail AS onec_detail, ob.attempts AS onec_attempts," : ""}
                to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
           FROM ${OPERATION_FROM}
           ${admin ? "LEFT JOIN onec_outbox ob ON ob.operation_id = o.id" : ""}
          WHERE ${conditions.join(" AND ")}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $${values.length}`,
        values,
      );

      // One more than asked for tells whether there is a next page without counting.
      const page = found.rows.slice(0, limit);
      const last = page.at(-1);
      return {
        from,
        to,
        operations: page.map((row) => (admin ? { ...toOperation(row), onec: oneCOf(row) } : toOperation(row))),
        nextCursor:
          found.rows.length > limit && last
            ? encodeCursor({ createdAt: last.created_at_cursor, id: last.id })
            : null,
      };
    },
  );

  // Who can be picked in the "cashier" filter of the owner and the admin: everyone who enters entries (cashier or admin),
  // also those whose access was withdrawn, since their old operations are still there.
  app.get(
    "/api/cashiers",
    { onRequest: [app.authenticate, app.requireRole("viewer", "admin")] },
    async () => {
      const found = await pool.query<{ login: string; display_name: string }>(
        `SELECT login, display_name FROM users WHERE role IN ('cashier', 'head_cashier', 'admin') ORDER BY display_name, login`,
      );
      return { cashiers: found.rows.map((row) => ({ login: row.login, displayName: row.display_name })) };
    },
  );
}
