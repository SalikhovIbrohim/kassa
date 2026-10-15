import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Queryable } from "./balances.js";
import { inTransaction } from "./ledger.js";
import { NO_NUL } from "./schemas.js";
import { cleanText } from "./text.js";

export type ClientsOptions = { pool: pg.Pool };

export type Client = { code: string; name: string; phone: string | null; note: string | null; active: boolean };

type ClientRow = { code: string; name: string; phone: string | null; note: string | null; active: boolean };
const toClient = (row: ClientRow): Client => ({ code: row.code, name: row.name, phone: row.phone, note: row.note, active: row.active });

/**
 * The code of a client in what a person typed: "а707", "A-707", "А707 Карим", "А34-2" give А707 and А34-2 (Cyrillic А,
 * the digits as they are); anything else, none. What follows the code (a name, say) is left aside.
 */
export function clientCodeIn(text: string): string | null {
  const found = /^\s*[AaАа]\s*-?\s*(\d{1,5})(-\d{1,3})?(?=\s|$)/.exec(text);
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
export async function clientOfEntry(db: Queryable, typed: string, keep?: string | null): Promise<{ clientCode: string } | { error: string }> {
  if (keep !== undefined && keep !== null && typed === keep) return { clientCode: typed };
  const any = await db.query("SELECT 1 FROM clients LIMIT 1");
  if (any.rowCount === 0) return { clientCode: typed };
  const code = clientCodeIn(typed);
  const found = code ? (await db.query<ClientRow>("SELECT * FROM clients WHERE code = $1 AND active", [code])).rows[0] : undefined;
  if (!found) return { error: "unknown_client" };
  return { clientCode: clientLabel(found) };
}

const UNIQUE_VIOLATION = "23505";
const codeProperty = { type: "string", minLength: 2, maxLength: 20, pattern: NO_NUL } as const;
const nameProperty = { type: "string", maxLength: 100, pattern: NO_NUL } as const;
const optionalText = (max: number) => ({ type: ["string", "null"], maxLength: max, pattern: NO_NUL }) as const;
const MAX_IMPORT = 5000;

const blankToNull = (text: string | null | undefined) => (text === undefined || text === null ? null : cleanText(text) || null);

/**
 * The directory of clients. Everybody reads it (the entry forms look clients up in it); the admin alone adds clients,
 * changes them, switches them off, and loads a whole list at once.
 */
export async function registerClients(app: FastifyInstance, options: ClientsOptions) {
  const { pool } = options;

  // A search by the beginning of the code or by a part of the name: the clients whose code starts with what was typed
  // first, then those whose name has it. Without `q`, all of them (the list of «Управление»). Switched off ones only
  // when asked for.
  app.get<{ Querystring: { q?: string; limit?: string; all?: string } }>(
    "/api/clients",
    {
      onRequest: app.authenticate,
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
      const limit = Math.min(Number(request.query.limit ?? (typed ? 20 : 5000)), 5000);
      const code = clientCodeIn(typed);
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
      return { clients: found.rows.map(toClient) };
    },
  );

  app.post<{ Body: { code: string; name?: string; phone?: string | null; note?: string | null } }>(
    "/api/admin/clients",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      schema: {
        body: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: { code: codeProperty, name: nameProperty, phone: optionalText(100), note: optionalText(500) },
        },
      },
    },
    async (request, reply) => {
      const code = clientCodeIn(request.body.code);
      if (!code || cleanText(request.body.code).replace(/\s/g, "").length > code.length + 1) {
        return reply.code(400).send({ error: "bad_code", message: "body/code must be a code like А707 or А34-2" });
      }
      try {
        const made = await pool.query<ClientRow>(
          "INSERT INTO clients (code, name, phone, note) VALUES ($1, $2, $3, $4) RETURNING *",
          [code, cleanText(request.body.name ?? ""), blankToNull(request.body.phone), blankToNull(request.body.note)],
        );
        return reply.code(201).send({ client: toClient(made.rows[0]!) });
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return reply.code(409).send({ error: "client_exists" });
        throw error;
      }
    },
  );

  // The admin changes the name, the phone, the note, or switches a client off (and on again). The code never changes:
  // the entries and 1C know the client by it.
  app.patch<{ Params: { code: string }; Body: { name?: string; phone?: string | null; note?: string | null; active?: boolean } }>(
    "/api/admin/clients/:code",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      schema: {
        params: { type: "object", required: ["code"], properties: { code: codeProperty } },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameProperty, phone: optionalText(100), note: optionalText(500), active: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const code = clientCodeIn(request.params.code);
      const body = request.body;
      const changed = await pool.query<ClientRow>(
        `UPDATE clients
            SET name = COALESCE($2, name),
                phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                note = CASE WHEN $5::boolean THEN $6 ELSE note END,
                active = COALESCE($7, active)
          WHERE code = $1 RETURNING *`,
        [
          code,
          body.name === undefined ? null : cleanText(body.name),
          body.phone !== undefined,
          blankToNull(body.phone),
          body.note !== undefined,
          blankToNull(body.note),
          body.active ?? null,
        ],
      );
      const row = changed.rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { client: toClient(row) };
    },
  );

  // A whole list at once (the clients of the old tables): new codes are added, codes already there are left as they
  // are. A code twice in the list is a mistake in the list: nothing is loaded, and the answer says which.
  app.post<{ Body: { clients: Array<{ code: string; name?: string; phone?: string | null }> } }>(
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
                properties: { code: codeProperty, name: nameProperty, phone: optionalText(100) },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rows = request.body.clients.map((item, index) => ({ line: index + 1, code: clientCodeIn(item.code), typed: item.code, name: cleanText(item.name ?? ""), phone: blankToNull(item.phone) }));
      const bad = rows.filter((row) => !row.code).map((row) => ({ line: row.line, code: row.typed }));
      if (bad.length > 0) return reply.code(400).send({ error: "bad_codes", rows: bad });
      const seen = new Map<string, number[]>();
      for (const row of rows) seen.set(row.code!, [...(seen.get(row.code!) ?? []), row.line]);
      const twice = [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([code, lines]) => ({ code, lines }));
      if (twice.length > 0) return reply.code(400).send({ error: "repeated_codes", codes: twice });

      const added = await inTransaction(pool, async (client) => {
        let count = 0;
        for (const row of rows) {
          const inserted = await client.query("INSERT INTO clients (code, name, phone) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING", [row.code, row.name, row.phone]);
          count += inserted.rowCount ?? 0;
        }
        return count;
      });
      return { added, skipped: rows.length - added };
    },
  );
}
