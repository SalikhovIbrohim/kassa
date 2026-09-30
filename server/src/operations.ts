import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances } from "./balances.js";
import { MAX_AMOUNT_MINOR } from "./money.js";

const MAX_SUGGESTIONS = 8;

export type OperationsOptions = {
  pool: pg.Pool;
  now: () => Date;
};

type OperationRow = {
  id: string;
  kind: "income";
  amount_minor: string;
  currency: "RUB" | "USD";
  client_code: string;
  comment: string | null;
  created_at: Date;
  author_login: string;
  author_display_name: string;
};

/** Makes %, _ and \\ in what a person typed ordinary characters in a LIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toOperation(row: OperationRow) {
  return {
    id: row.id,
    type: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    clientCode: row.client_code,
    comment: row.comment,
    author: { login: row.author_login, displayName: row.author_display_name },
    createdAt: row.created_at.toISOString(),
  };
}

export async function registerOperations(app: FastifyInstance, options: OperationsOptions) {
  const { pool, now } = options;

  app.get("/api/balances", { onRequest: app.authenticate }, async () => ({
    balances: await getBalances(pool),
  }));

  // Codes people typed before, to save typing: every code ever used, most recently used
  // first, matched on the lower-cased key so letter case works for Cyrillic too.
  app.get<{ Querystring: { prefix?: string } }>(
    "/api/client-codes",
    {
      onRequest: app.authenticate,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { prefix: { type: "string", maxLength: 64 } },
        },
      },
    },
    async (request) => {
      const prefix = (request.query.prefix ?? "").trim().toLowerCase();
      const found = await pool.query<{ client_code: string }>(
        `SELECT client_code FROM (
           SELECT DISTINCT ON (client_code_key) client_code, created_at
             FROM operations
            WHERE client_code_key LIKE $1 ESCAPE '\\'
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
        `SELECT currency FROM operations WHERE author_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [request.user!.id],
      );
      return { currency: last.rows[0]?.currency ?? "RUB" };
    },
  );

  app.post<{
    Body: {
      id: string;
      type: "income";
      amountMinor: number;
      currency: "RUB" | "USD";
      clientCode: string;
      comment?: string;
    };
  }>(
    "/api/operations",
    {
      // onRequest runs before the body is validated: who you are comes before what you sent.
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        body: {
          type: "object",
          required: ["id", "type", "amountMinor", "currency", "clientCode"],
          additionalProperties: false,
          properties: {
            id: { type: "string", format: "uuid" },
            type: { type: "string", enum: ["income"] },
            amountMinor: { type: "integer", minimum: 1, maximum: MAX_AMOUNT_MINOR },
            currency: { type: "string", enum: ["RUB", "USD"] },
            clientCode: { type: "string", minLength: 1, maxLength: 64 },
            comment: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const clientCode = body.clientCode.trim();
      if (clientCode === "") {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "body/clientCode must not be blank",
        });
      }
      const comment = body.comment?.trim() || null;
      const clientCodeKey = clientCode.toLowerCase();

      const values = [
        body.id,
        body.type,
        body.amountMinor,
        body.currency,
        clientCode,
        comment,
        request.user!.id,
        now(),
        clientCodeKey,
      ];

      // The id is the primary key, so two requests with the same id can never both insert.
      const inserted = await pool.query<OperationRow>(
        `WITH new_operation AS (
           INSERT INTO operations
             (id, kind, amount_minor, currency, client_code, comment, author_id, created_at, client_code_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING *
         )
         SELECT o.*, u.login AS author_login, u.display_name AS author_display_name
           FROM new_operation o JOIN users u ON u.id = o.author_id`,
        values,
      );
      if (inserted.rows[0]) {
        return reply.code(201).send({
          operation: toOperation(inserted.rows[0]),
          balances: await getBalances(pool),
        });
      }

      // The id exists already. Same author and same content means a retry: answer as before.
      const existing = await pool.query<OperationRow & { author_id: string }>(
        `SELECT o.*, u.login AS author_login, u.display_name AS author_display_name
           FROM operations o JOIN users u ON u.id = o.author_id
          WHERE o.id = $1`,
        [body.id],
      );
      const stored = existing.rows[0];
      const sameRequest =
        stored !== undefined &&
        stored.author_id === request.user!.id &&
        stored.kind === body.type &&
        Number(stored.amount_minor) === body.amountMinor &&
        stored.currency === body.currency &&
        stored.client_code === clientCode &&
        stored.comment === comment;
      if (!sameRequest) {
        return reply.code(409).send({ error: "operation_id_conflict" });
      }
      return reply.code(200).send({
        operation: toOperation(stored),
        balances: await getBalances(pool),
      });
    },
  );
}
