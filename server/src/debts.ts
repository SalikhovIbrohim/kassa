import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { readControl, readStatement } from "./client-debts.js";
import { clientCodeIn, type ClientCodes } from "./clients.js";
import { inTransaction } from "./ledger.js";
import { NO_NUL, NO_QUERY } from "./schemas.js";

export type DebtsOptions = {
  pool: pg.Pool;
  /** How the business writes the codes of its clients: «А707» unless said. */
  codes?: ClientCodes;
  /** The business keeps trips: only then do its clients have debts to look into. */
  cargo?: boolean;
};

/**
 * What the owner and the admin look into behind the debt of a client: the card of the client (every trip that arrived
 * and every payment, with the debt after each) and the control sheet of a year (what all the clients owed, month by
 * month). Both are what the card file of the business had on paper; both are worked out from the trips and the
 * payments, and stored nowhere. A business that keeps no trips has neither.
 */
export async function registerDebts(app: FastifyInstance, options: DebtsOptions) {
  const { pool } = options;
  const codes = options.codes ?? "letter";
  const lookers = [app.authenticate, app.requireRole("admin", "viewer")];
  const snapshot = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

  app.get<{ Params: { code: string } }>(
    "/api/clients/:code/statement",
    {
      onRequest: lookers,
      schema: { params: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 20, pattern: NO_NUL } } }, querystring: NO_QUERY },
    },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      const code = clientCodeIn(request.params.code, codes);
      const statement = code ? await inTransaction(pool, (db) => readStatement(db, codes, code), snapshot) : undefined;
      if (!statement) return reply.code(404).send({ error: "not_found" });
      return statement;
    },
  );

  app.get<{ Querystring: { year?: string } }>(
    "/api/debts/control",
    {
      onRequest: lookers,
      schema: { querystring: { type: "object", additionalProperties: false, properties: { year: { type: "string", pattern: "^20[0-9]{2}$" } } } },
    },
    async (request, reply) => {
      if (!options.cargo) return reply.code(404).send({ error: "trips_disabled" });
      // Without a year: the one that is running, by the calendar of Moscow.
      const year = Number(request.query.year ?? new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 4));
      return { year, months: await inTransaction(pool, (db) => readControl(db, codes, year), snapshot) };
    },
  );
}
