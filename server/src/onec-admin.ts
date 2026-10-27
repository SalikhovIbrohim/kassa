import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Queryable } from "./balances.js";

/**
 * What a person may do with a payment of a client in the queue of 1C, from the admin's journal (the buttons in the
 * column «1С») and from the server's command line (`onec-retry`, `onec-skip`). A payment that is written is never
 * written again, and nothing here changes or deletes anything in 1C.
 */
export type QueueChange = { done: true; docNumber: string | null } | { done: false; status: string | null };

/** The states a payment can be put back in the queue from: failed, waits for a person, skipped, only rehearsed. */
const RETRYABLE = ["failed", "blocked", "skipped", "preview"];
/** The states a payment can be given up from: anything that is not written or given up already. */
const SKIPPABLE = ["pending", "blocked", "failed", "preview"];

async function change(db: Queryable, id: number, sql: string, from: string[], values: unknown[] = []): Promise<QueueChange> {
  const done = await db.query<{ doc_number: string | null }>(sql, [id, from, ...values]);
  if (done.rowCount) return { done: true, docNumber: done.rows[0]!.doc_number };
  const row = (await db.query<{ status: string }>("SELECT status FROM onec_outbox WHERE id = $1", [id])).rows[0];
  return { done: false, status: row?.status ?? null };
}

/** Back in the queue: the worker takes it within a few seconds, and goes on with the document 1C made, if any. */
export const retryPayment = (db: Queryable, id: number) =>
  change(
    db,
    id,
    `UPDATE onec_outbox SET status = 'pending', attempts = 0, alerted = false, next_attempt_at = now(), detail = NULL
      WHERE id = $1 AND status = ANY($2) RETURNING doc_number`,
    RETRYABLE,
  );

/** Not to be written: it stays in the queue as skipped, with who decided it. */
export const skipPayment = (db: Queryable, id: number, why: string) =>
  change(db, id, "UPDATE onec_outbox SET status = 'skipped', detail = $3 WHERE id = $1 AND status = ANY($2) RETURNING doc_number", SKIPPABLE, [why]);

/** The admin's buttons: «Повторить» and «Не записывать» on a payment in the column «1С» of the journal. */
export async function registerOneCAdmin(app: FastifyInstance, options: { pool: pg.Pool }) {
  const { pool } = options;
  const admin = [app.authenticate, app.requireRole("admin")];
  const params = { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", pattern: "^[0-9]{1,12}$" } } } as const;

  const answer = (result: QueueChange) =>
    result.done ? { ok: true, docNumber: result.docNumber } : result.status === null ? { error: "not_found" } : { error: "wrong_state", status: result.status };

  app.post<{ Params: { id: string } }>("/api/admin/onec/:id/retry", { onRequest: admin, schema: { params } }, async (request, reply) => {
    const result = await retryPayment(pool, Number(request.params.id));
    if (!result.done) return reply.code(result.status === null ? 404 : 409).send(answer(result));
    return answer(result);
  });

  app.post<{ Params: { id: string } }>("/api/admin/onec/:id/skip", { onRequest: admin, schema: { params } }, async (request, reply) => {
    const who = request.user!.displayName;
    const result = await skipPayment(pool, Number(request.params.id), `пропущен вручную (${who})`);
    if (!result.done) return reply.code(result.status === null ? 404 : 409).send(answer(result));
    return answer(result);
  });
}
