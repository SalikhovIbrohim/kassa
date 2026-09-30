import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances } from "./balances.js";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_CODES,
  REFUND_CATEGORY,
  type ExpenseCategory,
} from "./categories.js";
import { recordOperation, toOperation } from "./ledger.js";
import { MAX_AMOUNT_MINOR } from "./money.js";

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

  app.get("/api/categories", { onRequest: app.authenticate }, async () => ({
    categories: EXPENSE_CATEGORIES,
  }));

  const commonProperties = {
    id: { type: "string", format: "uuid" },
    amountMinor: { type: "integer", minimum: 1, maximum: MAX_AMOUNT_MINOR },
    currency: { type: "string", enum: ["RUB", "USD"] },
    comment: { type: "string", maxLength: 500 },
  } as const;

  const clientCodeProperty = { type: "string", minLength: 1, maxLength: 64 } as const;

  app.post<{ Body: IncomeBody | ExpenseBody }>(
    "/api/operations",
    {
      // onRequest runs before the body is validated: who you are comes before what you sent.
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        body: {
          oneOf: [
            {
              type: "object",
              required: ["id", "type", "amountMinor", "currency", "clientCode"],
              additionalProperties: false,
              properties: {
                ...commonProperties,
                type: { type: "string", const: "income" },
                clientCode: clientCodeProperty,
              },
            },
            {
              type: "object",
              required: ["id", "type", "amountMinor", "currency", "category"],
              additionalProperties: false,
              properties: {
                ...commonProperties,
                type: { type: "string", const: "expense" },
                category: { type: "string", enum: EXPENSE_CATEGORY_CODES },
                recipient: { type: "string", maxLength: 100 },
                clientCode: clientCodeProperty,
              },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const badRequest = (message: string) =>
        reply.code(400).send({ statusCode: 400, error: "Bad Request", message });

      const comment = body.comment?.trim() || null;
      let category: ExpenseCategory | null = null;
      let recipient: string | null = null;
      let clientCode: string | null = null;

      if (body.type === "income") {
        clientCode = body.clientCode.trim();
        if (clientCode === "") return badRequest("body/clientCode must not be blank");
      } else {
        category = body.category;
        recipient = body.recipient?.trim() || null;
        if (category === REFUND_CATEGORY) {
          clientCode = body.clientCode?.trim() ?? "";
          if (clientCode === "") return badRequest("body/clientCode is required for a client refund");
        } else if (body.clientCode !== undefined) {
          return badRequest("body/clientCode is only allowed for a client refund");
        }
      }

      const recorded = await recordOperation(pool, {
        id: body.id,
        kind: body.type,
        amountMinor: body.amountMinor,
        currency: body.currency,
        category,
        recipient,
        clientCode,
        comment,
        authorId: request.user!.id,
        createdAt: now(),
      });

      switch (recorded.status) {
        case "created":
        case "replayed":
          return reply.code(recorded.status === "created" ? 201 : 200).send({
            operation: toOperation(recorded.row),
            balances: await getBalances(pool),
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

type IncomeBody = {
  id: string;
  type: "income";
  amountMinor: number;
  currency: "RUB" | "USD";
  clientCode: string;
  comment?: string;
};

type ExpenseBody = {
  id: string;
  type: "expense";
  amountMinor: number;
  currency: "RUB" | "USD";
  category: ExpenseCategory;
  recipient?: string;
  clientCode?: string;
  comment?: string;
};
