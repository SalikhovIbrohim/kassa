import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { getBalances } from "./balances.js";
import { readCategories } from "./categories.js";
import { entrySchema, normalizeEntry, type Entry } from "./entry.js";
import { recordOperation, toOperation, type LedgerEvents } from "./ledger.js";
import type { Outbox } from "./outbox.js";
import { NO_NUL, UUID } from "./schemas.js";

const MAX_SUGGESTIONS = 8;

export type OperationsOptions = {
  pool: pg.Pool;
  now: () => Date;
  /** What is written down with an operation besides it (the messages for the Telegram group). */
  events?: LedgerEvents;
  outbox: Outbox;
};

/** Makes %, _ and \\ in what a person typed ordinary characters in a LIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Who the sender is sending for, percent-encoded because a login may be in any alphabet. The queue of a
 * phone sends the login of the cashier who made the entry: the server takes the author from the session,
 * and a phone where somebody else has signed in since (in another tab, or while a send was under way)
 * must not book the entry under them. An entry without the header is the author's own, as it always was.
 */
const AUTHOR_HEADER = "x-kassa-as";

async function mustBeSentForTheSessionsOwner(request: FastifyRequest, reply: FastifyReply) {
  const claimed = request.headers[AUTHOR_HEADER];
  if (claimed === undefined) return;
  let said: string | undefined;
  try {
    said = typeof claimed === "string" ? decodeURIComponent(claimed) : undefined;
  } catch {
    said = undefined;
  }
  if (said === undefined || said.toLowerCase() !== request.user!.login.toLowerCase()) {
    return reply.code(409).send({
      error: "wrong_session",
      message: "This entry belongs to another cashier than the one who is signed in here.",
    });
  }
}

export async function registerOperations(app: FastifyInstance, options: OperationsOptions) {
  const { pool, now, events, outbox } = options;

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

  // The lists for the entry forms and for reading old entries. `categories` is the active expense categories (the
  // answer older phones know), `income` the active income categories, `all` every category of both kinds with
  // what the owner set on it, archived ones too: the journal still has to name them.
  app.get("/api/categories", { onRequest: app.authenticate }, async () => {
    const all = await readCategories(pool);
    return {
      categories: all.filter((item) => item.kind === "expense" && !item.archived),
      income: all.filter((item) => item.kind === "income" && !item.archived),
      all,
    };
  });

  app.post<{ Body: Entry & { id: string; shiftId?: string } }>(
    "/api/operations",
    {
      // onRequest runs before the body is validated: who you are comes before what you sent.
      onRequest: [app.authenticate, app.requireRole("cashier"), mustBeSentForTheSessionsOwner],
      schema: {
        // The id is made by the client, so that sending the same entry twice stores it once.
        // The shift is named by a phone that was offline when the entry was made; see `shiftFor` in the ledger.
        body: entrySchema({ properties: { id: UUID, shiftId: UUID }, required: ["id"] }),
      },
    },
    async (request, reply) => {
      const body = request.body;
      // An entry that is stored already (a retry) is not turned away because its category was archived since.
      const stored = await pool.query<{ category: string | null }>("SELECT category FROM operations WHERE id = $1", [body.id]);
      const normalized = normalizeEntry(body, await readCategories(pool), stored.rows[0]?.category);
      if ("error" in normalized) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: normalized.error });
      }

      const recorded = await recordOperation(pool, {
        id: body.id,
        kind: normalized.kind,
        ...normalized.fields,
        authorId: request.user!.id,
        createdAt: now(),
        shiftId: body.shiftId,
      }, events);
      // The messages were written with the operation; now that it is committed, the worker is asked to send them.
      if (recorded.status === "created") outbox.nudge();

      switch (recorded.status) {
        case "created":
        case "replayed":
          return reply.code(recorded.status === "created" ? 201 : 200).send({
            operation: toOperation(recorded.row),
            balances: recorded.balances,
          });
        case "id_conflict":
          return reply.code(409).send({ error: "operation_id_conflict" });
      }
    },
  );
}
