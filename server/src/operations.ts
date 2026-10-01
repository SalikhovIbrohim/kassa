import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances } from "./balances.js";
import { EXPENSE_CATEGORIES } from "./categories.js";
import { entrySchema, normalizeEntry, type Entry } from "./entry.js";
import { recordOperation, toOperation } from "./ledger.js";
import { NO_NUL, UUID } from "./schemas.js";

const MAX_SUGGESTIONS = 8;

export type OperationsOptions = {
  pool: pg.Pool;
  now: () => Date;
};

/** Makes %, _ and \\ in what a person typed ordinary characters in a LIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function registerOperations(app: FastifyInstance, options: OperationsOptions) {
  const { pool, now } = options;

  app.get("/api/balances", { onRequest: app.authenticate }, async () => ({
    balances: await getBalances(pool),
  }));

  // Codes people typed before, to save typing: every code in use, most recently used first,
  // matched on the lower-cased key so letter case works for Cyrillic too. A deleted
  // operation offers none.
  app.get<{ Querystring: { prefix?: string } }>(
    "/api/client-codes",
    {
      onRequest: app.authenticate,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { prefix: { type: "string", maxLength: 64, pattern: NO_NUL } },
        },
      },
    },
    async (request) => {
      const prefix = (request.query.prefix ?? "").trim().toLowerCase();
      const found = await pool.query<{ client_code: string }>(
        `SELECT client_code FROM (
           SELECT DISTINCT ON (client_code_key) client_code, created_at
             FROM operations
            WHERE client_code_key LIKE $1 ESCAPE '\\' AND deleted_at IS NULL
            ORDER BY client_code_key, created_at DESC
         ) latest
         ORDER BY created_at DESC, client_code
         LIMIT $2`,
        [`${escapeLike(prefix)}%`, MAX_SUGGESTIONS],
      );
      return { codes: found.rows.map((row) => row.client_code) };
    },
  );

  // What the form should start with: the currency this person used last.
  app.get(
    "/api/operations/defaults",
    { onRequest: app.authenticate },
    async (request) => {
      const last = await pool.query<{ currency: "RUB" | "USD" }>(
        `SELECT currency FROM operations WHERE author_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [request.user!.id],
      );
      return { currency: last.rows[0]?.currency ?? "RUB" };
    },
  );

  app.get("/api/categories", { onRequest: app.authenticate }, async () => ({
    categories: EXPENSE_CATEGORIES,
  }));

  app.post<{ Body: Entry & { id: string } }>(
    "/api/operations",
    {
      // onRequest runs before the body is validated: who you are comes before what you sent.
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        // The id is made by the client, so that sending the same entry twice stores it once.
        body: entrySchema({ properties: { id: UUID }, required: ["id"] }),
      },
    },
    async (request, reply) => {
      const body = request.body;
      const normalized = normalizeEntry(body);
      if ("error" in normalized) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: normalized.error });
      }

      const recorded = await recordOperation(pool, {
        id: body.id,
        kind: normalized.kind,
        ...normalized.fields,
        authorId: request.user!.id,
        createdAt: now(),
      });

      switch (recorded.status) {
        case "created":
        case "replayed":
          return reply.code(recorded.status === "created" ? 201 : 200).send({
            operation: toOperation(recorded.row),
            balances: recorded.balances,
          });
        case "id_conflict":
          return reply.code(409).send({ error: "operation_id_conflict" });
        case "insufficient_balance":
          return reply.code(422).send({
            error: "insufficient_balance",
            currency: body.currency,
            availableMinor: recorded.availableMinor,
            requestedMinor: body.amountMinor,
          });
      }
    },
  );
}
