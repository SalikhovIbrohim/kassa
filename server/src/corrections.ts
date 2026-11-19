import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { getBalances } from "./balances.js";
import { readCategories } from "./categories.js";
import { clientOfEntry, type ClientCodes } from "./clients.js";
import { entrySchema, normalizeEntry, type Entry } from "./entry.js";
import type { Kassas } from "./kassa.js";
import { kassaOfCategory } from "./operations.js";
import { changeOperation, readHistory, toOperation, type Change, type ChangeResult, type LedgerEvents } from "./ledger.js";
import type { Outbox } from "./outbox.js";
import { NO_NUL, NO_QUERY, UUID } from "./schemas.js";
import { cleanText } from "./text.js";

export type CorrectionsOptions = {
  pool: pg.Pool;
  now: () => Date;
  /** The cash desks of the installation. */
  kassas: Kassas;
  /** How the business writes the codes of its clients: «А707» unless said. */
  clientCodes?: ClientCodes;
  events?: LedgerEvents;
  outbox: Pick<Outbox, "nudge">;
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: UUID },
} as const;

const reasonProperty = { type: "string", maxLength: 500, pattern: NO_NUL } as const;

/** How a cashier corrects or deletes their own operations. */
export async function registerCorrections(app: FastifyInstance, options: CorrectionsOptions) {
  const { pool, now, kassas, events, outbox } = options;

  async function apply(reply: FastifyReply, user: { id: string; role: string; city: string | null }, id: string, change: Change) {
    const result = await changeOperation(pool, { id, actorId: user.id, actorIsAdmin: user.role === "admin", now, change, kassas, events });
    if (result.status === "changed") outbox.nudge();
    // An entry a category sent into a desk that is not the person's (see `kassaOfCategory`): the balances they are
    // shown stay those of their own desk.
    if ((result.status === "changed" || result.status === "unchanged") && !kassas.mayUse(user.city, result.row.kassa)) {
      const own = kassas.defaultOf(user.city);
      return answer(reply, { ...result, balances: await getBalances(pool, kassas.currenciesOf(own), own) });
    }
    return answer(reply, result);
  }

  // Correcting replaces what the cashier may change (amount, currency, category, recipient,
  // client code, comment) with what is sent; what is not sent is cleared. The kind of the
  // operation, its author and its time never change. The reason is optional.
  app.put<{ Params: { id: string }; Body: Entry & { reason?: string } }>(
    "/api/operations/:id",
    {
      onRequest: [app.authenticate, app.requireRole("cashier", "head_cashier", "admin")],
      schema: {
        params: idParams,
        // The reason belongs in the body: one in the query string would be dropped unheard.
        querystring: NO_QUERY,
        body: entrySchema({ properties: { reason: reasonProperty }, required: [] }, kassas),
      },
    },
    async (request, reply) => {
      // A correction that leaves the category as it is stays valid after the category was archived.
      const stored = await pool.query<{ category: string | null; client_code: string | null; kassa: string; to_kassa: string | null }>("SELECT category, client_code, kassa, to_kassa FROM operations WHERE id = $1", [request.params.id]);
      const categories = await readCategories(pool);
      const normalized = normalizeEntry(request.body, categories, stored.rows[0]?.category, { toKassa: stored.rows[0]?.to_kassa ?? null });
      if ("error" in normalized) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: normalized.error });
      }
      // Money moved to another desk stays money moved to that desk, and no other expense becomes one: the income of
      // the other desk was written with it. What was entered wrongly is deleted and entered anew.
      if (stored.rows[0] && (normalized.toKassa !== stored.rows[0].to_kassa || (stored.rows[0].to_kassa !== null && !categories.find((item) => item.code === normalized.fields.category)?.transfer))) {
        return reply.code(409).send({ error: "transfer_cannot_change" });
      }
      // An entry stays in the desk it was written into. A category that sends its money to another desk cannot be
      // given to it: that would be other money, entered anew.
      const into = kassaOfCategory(categories, normalized.fields.category, kassas);
      if (stored.rows[0] && normalized.fields.category !== stored.rows[0].category && into !== undefined && into !== stored.rows[0].kassa) {
        return reply.code(409).send({ error: "category_of_another_kassa" });
      }
      // A client of the directory; one the entry named before may stay, even when it is not (or no longer) in it.
      if (normalized.fields.clientCode !== null) {
        const client = await clientOfEntry(pool, normalized.fields.clientCode, stored.rows[0]?.client_code, options.clientCodes);
        if ("error" in client) return reply.code(400).send({ statusCode: 400, error: client.error, message: "body/clientCode is not a client of the directory" });
        normalized.fields.clientCode = client.clientCode;
      }
      return apply(reply, request.user!, request.params.id, {
        action: "edit",
        kind: normalized.kind,
        next: normalized.fields,
        reason: cleanText(request.body.reason ?? "") || null,
      });
    },
  );

  // The whole story of an operation, for the people who watch over the cash desk (the owner and the admin). A
  // cashier does not get it, not even for their own operations.
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/history",
    {
      onRequest: [app.authenticate, app.requireRole("viewer", "admin")],
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
      onRequest: [app.authenticate, app.requireRole("cashier", "head_cashier", "admin")],
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
      return apply(reply, request.user!, request.params.id, { action: "delete", reason });
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
    case "too_late":
      return reply.code(403).send({ error: "change_window_closed" });
    case "deleted":
      return reply.code(409).send({ error: "operation_deleted" });
    case "kind_changed":
      return reply.code(409).send({ error: "type_cannot_change" });
    case "transfer_income":
      return reply.code(409).send({ error: "transfer_income" });
    case "currency_not_kept":
      return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/currency is not kept by the cash desk of this entry" });
  }
}
