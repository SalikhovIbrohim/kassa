import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Queryable } from "./balances.js";
import { cashDayOf } from "./cash-day.js";
import { NO_DEBT, readDebts, type ClientDebt } from "./client-debts.js";
import { inTransaction } from "./ledger.js";
import { NO_NUL } from "./schemas.js";
import { cleanText } from "./text.js";

export type ClientsOptions = {
  pool: pg.Pool;
  /** How the business writes the codes of its clients: «А707» unless said. */
  codes?: ClientCodes;
  /**
   * The business keeps trips (its settings name warehouses, see warehouses.ts): a client then has a price for a
   * kilogram and a debt, and the directory says them. Without it the directory is as it always was.
   */
  cargo?: boolean;
  /** The application's clock: how long a client has not paid is counted up to the day of the cash desk it is. */
  now?: () => Date;
};

export type Client = { code: string; name: string; phone: string | null; note: string | null; active: boolean };

/** A client of a business that keeps trips: what a kilogram costs them (thousandths of a dollar), and what they owe. */
export type ClientWithDebt = Client & { priceMilli: number | null } & ClientDebt;

type ClientRow = { code: string; name: string; phone: string | null; note: string | null; active: boolean; price_milli: number | null };
const toClient = (row: ClientRow): Client => ({ code: row.code, name: row.name, phone: row.phone, note: row.note, active: row.active });
const toClientWithDebt = (row: ClientRow, debt: ClientDebt | undefined): ClientWithDebt => ({ ...toClient(row), priceMilli: row.price_milli, ...(debt ?? NO_DEBT) });

/**
 * How a business writes the codes of its clients (CLIENT_CODES in the settings of its installation): the letter А and
 * digits («А707», "letter"), or digits alone («707», "digits").
 */
export type ClientCodes = "letter" | "digits";

export function parseClientCodes(text: string | undefined): ClientCodes {
  const said = text?.trim().toLowerCase() || "letter";
  if (said !== "letter" && said !== "digits") throw new Error(`CLIENT_CODES must be letter (А707) or digits (707), got "${text}"`);
  return said;
}

/** A code of each kind, for what is said to a person. */
export const clientCodeExample = (codes: ClientCodes) => (codes === "digits" ? "707" : "А707");

/**
 * The code of a client in what a person typed: "а707", "A-707", "707", "А707 Карим", "А34-2", "34-2" give А707 and А34-2
 * (Cyrillic А, the digits as they are; the letter may be left out, every code has it); anything else, none. What follows the code (a name, say) is left aside.
 * Where the codes are digits alone, "707", "707 Карим", "34-2" give 707 and 34-2, and a letter before the digits is not a code.
 */
export function clientCodeIn(text: string, codes: ClientCodes = "letter"): string | null {
  if (codes === "digits") {
    const digits = /^\s*(\d{1,9})(-\d{1,3})?(?=\s|$)/.exec(text);
    return digits ? `${digits[1]}${digits[2] ?? ""}` : null;
  }
  const found = /^\s*(?:[AaАа]\s*-?\s*)?(\d{1,5})(-\d{1,3})?(?=\s|$)/.exec(text);
  return found ? `А${found[1]}${found[2] ?? ""}` : null;
}

/** How an entry names a client: the code and the name ("А707 Карим"), or the code alone. */
export const clientLabel = (client: Pick<Client, "code" | "name">) => (client.name ? `${client.code} ${client.name}` : client.code);

/**
 * The client an entry names, from the directory: `{ clientCode }` is how the entry says it from now on ("А707 Карим"),
 * whatever was typed. While the directory is empty (before the first list was loaded) every code is taken as typed, so
 * that loading it is not a condition for working. `keep` is what the entry said before (a correction): a code that is
 * not in the directory, or was switched off since, may stay as it was.
 */
export async function clientOfEntry(db: Queryable, typed: string, keep?: string | null, codes: ClientCodes = "letter"): Promise<{ clientCode: string } | { error: string }> {
  if (keep !== undefined && keep !== null && typed === keep) return { clientCode: typed };
  const any = await db.query("SELECT 1 FROM clients LIMIT 1");
  if (any.rowCount === 0) return { clientCode: typed };
  const code = clientCodeIn(typed, codes);
  const found = code ? (await db.query<ClientRow>("SELECT * FROM clients WHERE code = $1 AND active", [code])).rows[0] : undefined;
  if (!found) return { error: "unknown_client" };
  return { clientCode: clientLabel(found) };
}

const UNIQUE_VIOLATION = "23505";
// One sign is a code too where the codes are digits alone (the client 3); what is a code, `clientCodeIn` says.
const codeProperty = { type: "string", minLength: 1, maxLength: 20, pattern: NO_NUL } as const;
const nameProperty = { type: "string", maxLength: 100, pattern: NO_NUL } as const;
const optionalText = (max: number) => ({ type: ["string", "null"], maxLength: max, pattern: NO_NUL }) as const;
const MAX_IMPORT = 5000;
/** The price of a kilogram in thousandths of a dollar (1,55 $ is 1550), or none; and what a client owed at the start, in cents. */
const priceProperty = { type: ["integer", "null"], minimum: 0, maximum: 1_000_000 } as const;
const openingDebtProperty = { type: "integer", minimum: -10_000_000_000, maximum: 10_000_000_000 } as const;

const blankToNull = (text: string | null | undefined) => (text === undefined || text === null ? null : cleanText(text) || null);

/**
 * The directory of clients. Everybody reads it (the entry forms look clients up in it); the admin alone adds clients,
 * changes them, switches them off, and loads a whole list at once.
 */
export async function registerClients(app: FastifyInstance, options: ClientsOptions) {
  const { pool } = options;
  const codes = options.codes ?? "letter";
  const cargo = options.cargo ?? false;
  // What only a business that keeps trips sets on a client; any other is refused these fields, as it always was.
  const cargoProperties = cargo ? { priceMilli: priceProperty, openingDebtMinor: openingDebtProperty } : {};
  /** The clients as the directory says them: with what each owes where the business keeps trips. */
  const present = async (db: Queryable, rows: ClientRow[]): Promise<Client[]> => {
    if (!cargo) return rows.map(toClient);
    // A few clients are asked for by their codes; the whole list is read whole.
    const debts = await readDebts(db, codes, rows.length <= 50 ? rows.map((row) => row.code) : undefined, cashDayOf((options.now ?? (() => new Date()))()));
    return rows.map((row) => toClientWithDebt(row, debts.get(row.code)));
  };

  // A search by the beginning of the code or by a part of the name: the clients whose code starts with what was typed
  // first, then those whose name has it. Without `q`, all of them (the list of «Управление»). Switched off ones only
  // when asked for.
  app.get<{ Querystring: { q?: string; limit?: string; all?: string } }>(
    "/api/clients",
    {
      onRequest: app.authenticate,
      // The keeper of a warehouse names the client of every line of cargo.
      config: { warehouse: true },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 64, pattern: NO_NUL },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" },
            all: { type: "string", enum: ["1"] },
          },
        },
      },
    },
    async (request) => {
      const typed = cleanText(request.query.q ?? "");
      // A guest gets what the form's suggestions need, and no more: a few codes and names for what he typed, never
      // the whole directory, the phones or the notes.
      const guest = request.user!.role === "guest";
      if (guest && !typed) return { clients: [] };
      const limit = guest ? 5 : Math.min(Number(request.query.limit ?? (typed ? 20 : 5000)), 5000);
      const code = clientCodeIn(typed, codes);
      const codePrefix = (code ?? typed).toLowerCase().replace(/^a/, "а");
      const found = await pool.query<ClientRow>(
        `SELECT * FROM clients
          WHERE ($1::boolean OR active)
            AND ($2 = '' OR lower(code) LIKE $3 || '%' OR lower(name) LIKE '%' || lower($2) || '%')
          ORDER BY (lower(code) = $3) DESC, (lower(code) LIKE $3 || '%') DESC,
                   substring(code from '[0-9]+')::int, code
          LIMIT $4`,
        [request.query.all === "1", typed, codePrefix, limit],
      );
      // `codes` tells the screen of the clients how a code is written here (what it says of a code, which lines of a file are clients).
      const clients = await present(pool, found.rows);
      return { clients: guest ? clients.map((client) => ({ ...client, phone: null, note: null })) : clients, codes };
    },
  );

  app.post<{ Body: { code: string; name?: string; phone?: string | null; note?: string | null; priceMilli?: number | null; openingDebtMinor?: number } }>(
    "/api/admin/clients",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      schema: {
        body: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: { code: codeProperty, name: nameProperty, phone: optionalText(100), note: optionalText(500), ...cargoProperties },
        },
      },
    },
    async (request, reply) => {
      const code = clientCodeIn(request.body.code, codes);
      // Nothing but the code: "А-707" is one sign longer than its code, digits alone are the code itself.
      if (!code || cleanText(request.body.code).replace(/\s/g, "").length > code.length + (codes === "letter" ? 1 : 0)) {
        return reply.code(400).send({ error: "bad_code", message: `body/code must be a code like ${clientCodeExample(codes)}` });
      }
      // A client is a code and a name, both: a code alone tells nobody who it is.
      if (cleanText(request.body.name ?? "") === "") return reply.code(400).send({ error: "bad_name", message: "body/name is required: a client has a code and a name" });
      try {
        const made = await pool.query<ClientRow>(
          "INSERT INTO clients (code, name, phone, note, price_milli, opening_debt_minor) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
          [code, cleanText(request.body.name ?? ""), blankToNull(request.body.phone), blankToNull(request.body.note), request.body.priceMilli ?? null, request.body.openingDebtMinor ?? 0],
        );
        return reply.code(201).send({ client: (await present(pool, made.rows))[0]! });
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return reply.code(409).send({ error: "client_exists" });
        throw error;
      }
    },
  );

  // The admin changes the name, the phone, the note, or switches a client off (and on again). The code never changes:
  // the entries and 1C know the client by it.
  app.patch<{ Params: { code: string }; Body: { name?: string; phone?: string | null; note?: string | null; active?: boolean; priceMilli?: number | null; openingDebtMinor?: number } }>(
    "/api/admin/clients/:code",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      schema: {
        params: { type: "object", required: ["code"], properties: { code: codeProperty } },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameProperty, phone: optionalText(100), note: optionalText(500), active: { type: "boolean" }, ...cargoProperties },
        },
      },
    },
    async (request, reply) => {
      const code = clientCodeIn(request.params.code, codes);
      const body = request.body;
      // The name may be changed, never taken away.
      if (body.name !== undefined && cleanText(body.name) === "") return reply.code(400).send({ error: "bad_name", message: "body/name cannot be empty" });
      const changed = await pool.query<ClientRow>(
        `UPDATE clients
            SET name = COALESCE($2, name),
                phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                note = CASE WHEN $5::boolean THEN $6 ELSE note END,
                active = COALESCE($7, active),
                price_milli = CASE WHEN $8::boolean THEN $9 ELSE price_milli END,
                opening_debt_minor = COALESCE($10, opening_debt_minor)
          WHERE code = $1 RETURNING *`,
        [
          code,
          body.name === undefined ? null : cleanText(body.name),
          body.phone !== undefined,
          blankToNull(body.phone),
          body.note !== undefined,
          blankToNull(body.note),
          body.active ?? null,
          body.priceMilli !== undefined,
          body.priceMilli ?? null,
          body.openingDebtMinor ?? null,
        ],
      );
      const row = changed.rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { client: (await present(pool, [row]))[0]! };
    },
  );

  // A whole list at once (the clients of the old tables): new codes are added, codes already there are left as they
  // are. A code twice in the list is a mistake in the list: nothing is loaded, and the answer says which.
  app.post<{ Body: { clients: Array<{ code: string; name?: string; phone?: string | null; priceMilli?: number | null; openingDebtMinor?: number }> } }>(
    "/api/admin/clients/import",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        body: {
          type: "object",
          required: ["clients"],
          additionalProperties: false,
          properties: {
            clients: {
              type: "array",
              minItems: 1,
              maxItems: MAX_IMPORT,
              items: {
                type: "object",
                required: ["code"],
                additionalProperties: false,
                properties: { code: codeProperty, name: nameProperty, phone: optionalText(100), ...cargoProperties },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rows = request.body.clients.map((item, index) => ({
        line: index + 1,
        code: clientCodeIn(item.code, codes),
        typed: item.code,
        name: cleanText(item.name ?? ""),
        phone: blankToNull(item.phone),
        priceMilli: item.priceMilli ?? null,
        openingDebtMinor: item.openingDebtMinor ?? 0,
      }));
      const bad = rows.filter((row) => !row.code).map((row) => ({ line: row.line, code: row.typed }));
      if (bad.length > 0) return reply.code(400).send({ error: "bad_codes", rows: bad });
      // A client is a code and a name, both: a list with a nameless line is put right first, and nothing of it is loaded.
      const nameless = rows.filter((row) => row.name === "").map((row) => ({ line: row.line, code: row.code }));
      if (nameless.length > 0) return reply.code(400).send({ error: "nameless", rows: nameless });
      const seen = new Map<string, number[]>();
      for (const row of rows) seen.set(row.code!, [...(seen.get(row.code!) ?? []), row.line]);
      const twice = [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([code, lines]) => ({ code, lines }));
      if (twice.length > 0) return reply.code(400).send({ error: "repeated_codes", codes: twice });

      const added = await inTransaction(pool, async (client) => {
        let count = 0;
        for (const row of rows) {
          const inserted = await client.query(
            "INSERT INTO clients (code, name, phone, price_milli, opening_debt_minor) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING",
            [row.code, row.name, row.phone, row.priceMilli, row.openingDebtMinor],
          );
          count += inserted.rowCount ?? 0;
        }
        return count;
      });
      return { added, skipped: rows.length - added };
    },
  );
}
