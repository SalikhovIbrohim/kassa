import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { entrySchema, normalizeEntry, type Entry } from "./entry.js";
import { changeOperation, readHistory, toOperation, type Change, type ChangeResult } from "./ledger.js";
import { NO_NUL, NO_QUERY, UUID } from "./schemas.js";
import { cleanText } from "./text.js";

export type CorrectionsOptions = {
  pool: pg.Pool;
  now: () => Date;
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: UUID },
} as const;

const reasonProperty = { type: "string", maxLength: 500, pattern: NO_NUL } as const;

/** How a cashier corrects or deletes their own operations. */
export async function registerCorrections(app: FastifyInstance, options: CorrectionsOptions) {
  const { pool, now } = options;

  async function apply(reply: FastifyReply, userId: string, id: string, change: Change) {
    const result = await changeOperation(pool, { id, actorId: userId, now, change });
    return answer(reply, result);
  }

  // Correcting replaces what the cashier may change (amount, currency, category, recipient,
  // client code, comment) with what is sent; what is not sent is cleared. The kind of the
  // operation, its author and its time never change. The reason is optional.
  app.put<{ Params: { id: string }; Body: Entry & { reason?: string } }>(
    "/api/operations/:id",
    {
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        params: idParams,
        // The reason belongs in the body: one in the query string would be dropped unheard.
        querystring: NO_QUERY,
        body: entrySchema({ properties: { reason: reasonProperty }, required: [] }),
      },
    },
    async (request, reply) => {
      const normalized = normalizeEntry(request.body);
      if ("error" in normalized) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: normalized.error });
      }
      return apply(reply, request.user!.id, request.params.id, {
        action: "edit",
        kind: normalized.kind,
        next: normalized.fields,
        reason: cleanText(request.body.reason ?? "") || null,
      });
    },
  );

  // The whole story of an operation, for the person who watches over the cash desk. A
  // cashier does not get it, not even for their own operations.
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/history",
    {
      onRequest: [app.authenticate, app.requireRole("viewer")],
      schema: { params: idParams, querystring: NO_QUERY },
    },
    async (request, reply) => {
      const history = await readHistory(pool, request.params.id);
      if (!history) return reply.code(404).send({ error: "not_found" });
      return history;
    },
  );

  // Deleting is logical: the operation stays, marked, in the history. It can be asked for
  // again without harm. The reason, if there is one, is kept with it.
  app.delete<{ Params: { id: string }; Body: { reason?: string } | undefined }>(
    "/api/operations/:id",
    {
      // Who you are comes before what you sent.
      onRequest: [app.authenticate, app.requireRole("cashier")],
      schema: {
        params: idParams,
        querystring: NO_QUERY,
        body: {
          anyOf: [
            { type: "null" },
            { type: "object", additionalProperties: false, properties: { reason: reasonProperty } },
          ],
        },
      },
    },
    async (request, reply) => {
      const reason = cleanText(request.body?.reason ?? "") || null;
      return apply(reply, request.user!.id, request.params.id, { action: "delete", reason });
    },
  );
}

/** The answer for a change: the operation as it is now and the balances, or why not. */
function answer(reply: FastifyReply, result: ChangeResult) {
  switch (result.status) {
    case "changed":
    case "unchanged":
      return reply.code(200).send({ operation: toOperation(result.row), balances: result.balances });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
    case "not_yours":
      return reply.code(403).send({ error: "forbidden" });
    case "deleted":
      return reply.code(409).send({ error: "operation_deleted" });
    case "kind_changed":
      return reply.code(409).send({ error: "type_cannot_change" });
  }
}
