import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { readCategories, type Category } from "./categories.js";
import { inTransaction } from "./ledger.js";
import { NO_NUL, NO_QUERY } from "./schemas.js";
import { cleanText } from "./text.js";

export type CategoryAdminOptions = {
  pool: pg.Pool;
};

/** A city, or null for everywhere. */
const cityProperty = { type: ["string", "null"], enum: ["andijan", "moscow", null] } as const;

const labelProperty = { type: "string", minLength: 1, maxLength: 60, pattern: NO_NUL } as const;

const UNIQUE_VIOLATION = "23505";

/** The same label twice in one list is the only thing the table refuses besides a bad shape. */
function isDuplicateLabel(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * The lists of categories: the admin adds one, renames it, says whether it names a client, moves it in the
 * list, and archives it when it is not wanted any more (never deletes: old entries keep reading it). Only the admin
 * may; the owner and the cashiers only read the lists (see `/api/categories`).
 */
export async function registerCategoryAdmin(app: FastifyInstance, options: CategoryAdminOptions) {
  const { pool } = options;
  const admin = [app.authenticate, app.requireRole("admin")];

  /** One change at a time, so that two taps cannot each see the same order and number two categories alike. */
  const lockCategories = (client: pg.ClientBase) => client.query("SELECT pg_advisory_xact_lock(hashtext('kassa.categories'))");

  app.post<{ Body: { kind: "income" | "expense"; label: string; requiresClient?: boolean; requiresTrip?: boolean; requiresCounterparty?: boolean; requiresEmployee?: boolean; notifyGroup?: boolean; city?: "andijan" | "moscow" | null } }>(
    "/api/admin/categories",
    {
      onRequest: admin,
      schema: {
        querystring: NO_QUERY,
        body: {
          type: "object",
          required: ["kind", "label"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["income", "expense"] },
            label: labelProperty,
            requiresClient: { type: "boolean" },
            requiresTrip: { type: "boolean" },
            requiresCounterparty: { type: "boolean" },
            requiresEmployee: { type: "boolean" },
            notifyGroup: { type: "boolean" },
            city: cityProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const label = cleanText(request.body.label);
      if (label === "") return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/label must not be blank" });
      try {
        const created = await inTransaction(pool, async (client) => {
          await lockCategories(client);
          // A code is made once and never changes, so it says nothing about the label that it started with.
          const code = `c_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          await client.query(
            `INSERT INTO categories (code, kind, label, sort_order, requires_client, notify_group, requires_trip, requires_counterparty, requires_employee, city)
             VALUES ($1, $2, $3, COALESCE((SELECT max(sort_order) FROM categories WHERE kind = $2), 0) + 1, $4, $5, $6, $7, $8, $9)`,
            [code, request.body.kind, label, request.body.requiresClient ?? false, request.body.notifyGroup ?? true, request.body.requiresTrip ?? false, request.body.requiresCounterparty ?? false, request.body.requiresEmployee ?? false, request.body.city ?? null],
          );
          return code;
        });
        const all = await readCategories(pool);
        return reply.code(201).send({ category: all.find((item) => item.code === created), all });
      } catch (error) {
        if (isDuplicateLabel(error)) return reply.code(409).send({ error: "category_exists" });
        throw error;
      }
    },
  );

  app.patch<{
    Params: { code: string };
    Body: { label?: string; requiresClient?: boolean; requiresTrip?: boolean; requiresCounterparty?: boolean; requiresEmployee?: boolean; notifyGroup?: boolean; archived?: boolean; move?: "up" | "down"; position?: number; kind?: "income" | "expense"; city?: "andijan" | "moscow" | null };
  }>(
    "/api/admin/categories/:code",
    {
      onRequest: admin,
      schema: {
        querystring: NO_QUERY,
        params: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9_]+$" } } },
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            label: labelProperty,
            requiresClient: { type: "boolean" },
            requiresTrip: { type: "boolean" },
            requiresCounterparty: { type: "boolean" },
            requiresEmployee: { type: "boolean" },
            notifyGroup: { type: "boolean" },
            archived: { type: "boolean" },
            // An income category becomes an expense one or back, only while no entry was made in it.
            kind: { type: "string", enum: ["income", "expense"] },
            city: cityProperty,
            move: { type: "string", enum: ["up", "down"] },
            // Where to put it in the list of its kind, counted from 0 (dragged there with the mouse); past the end is the end.
            position: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code } = request.params;
      const change = request.body;
      const label = change.label === undefined ? undefined : cleanText(change.label);
      if (label === "") return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/label must not be blank" });

      try {
        const result = await inTransaction(pool, async (client): Promise<"not_found" | "last_category" | "kind_locked" | "category_used" | "done"> => {
          await lockCategories(client);
          const all = await readCategories(client);
          const found = all.find((item) => item.code === code);
          if (!found) return "not_found";

          // At least one category of each kind stays in use: a form with an empty list cannot be filled in.
          if (change.archived === true && !found.archived) {
            const stillInUse = all.filter((item) => item.kind === found.kind && !item.archived && item.code !== code);
            if (stillInUse.length === 0) return "last_category";
          }

          if (change.kind !== undefined && change.kind !== found.kind) {
            // The payment of a client goes to 1C, and the handover to the owner is not a cost: both are what they are.
            if (found.code === "client_payment" || !found.countsAsCost) return "kind_locked";
            // Entries already made in it would turn from incomes into expenses: not while there is one.
            const used = await client.query("SELECT 1 FROM operations WHERE category = $1 LIMIT 1", [code]);
            if (used.rowCount !== 0) return "category_used";
            if (!found.archived && all.filter((item) => item.kind === found.kind && !item.archived && item.code !== code).length === 0) return "last_category";
            // It goes to the end of the other list.
            await client.query(
              "UPDATE categories SET kind = $2, sort_order = COALESCE((SELECT max(sort_order) FROM categories WHERE kind = $2), 0) + 1 WHERE code = $1",
              [code, change.kind],
            );
            found.kind = change.kind;
          }

          await client.query(
            `UPDATE categories
                SET label = COALESCE($2, label), requires_client = COALESCE($3, requires_client),
                    archived = COALESCE($4, archived), notify_group = COALESCE($5, notify_group),
                    requires_trip = COALESCE($6, requires_trip), requires_counterparty = COALESCE($7, requires_counterparty),
                    requires_employee = COALESCE($8, requires_employee),
                    city = CASE WHEN $9::boolean THEN $10 ELSE city END
              WHERE code = $1`,
            [code, label ?? null, change.requiresClient ?? null, change.archived ?? null, change.notifyGroup ?? null, change.requiresTrip ?? null, change.requiresCounterparty ?? null, change.requiresEmployee ?? null, change.city !== undefined, change.city ?? null],
          );

          if (change.move !== undefined) {
            const list = (await readCategories(client)).filter((item) => item.kind === found.kind);
            const at = list.findIndex((item) => item.code === code);
            const neighbour: Category | undefined = list[at + (change.move === "up" ? -1 : 1)];
            if (neighbour) {
              // The two trade places; numbers are renumbered from 1 first, so that equal numbers cannot make a tie.
              for (const [index, item] of list.entries()) {
                await client.query("UPDATE categories SET sort_order = $2 WHERE code = $1", [item.code, index + 1]);
              }
              const neighbourAt = list.indexOf(neighbour);
              await client.query("UPDATE categories SET sort_order = $2 WHERE code = $1", [code, neighbourAt + 1]);
              await client.query("UPDATE categories SET sort_order = $2 WHERE code = $1", [neighbour.code, at + 1]);
            }
          }
          if (change.position !== undefined) {
            const others = all.filter((item) => item.kind === found.kind && item.code !== code);
            others.splice(Math.min(change.position, others.length), 0, found);
            for (const [index, item] of others.entries()) {
              await client.query("UPDATE categories SET sort_order = $2 WHERE code = $1", [item.code, index + 1]);
            }
          }
          return "done";
        });

        if (result === "not_found") return reply.code(404).send({ error: "not_found" });
        if (result === "last_category") return reply.code(409).send({ error: "last_category" });
        if (result === "kind_locked" || result === "category_used") return reply.code(409).send({ error: result });
        const all = await readCategories(pool);
        return { category: all.find((item) => item.code === code), all };
      } catch (error) {
        if (isDuplicateLabel(error)) return reply.code(409).send({ error: "category_exists" });
        throw error;
      }
    },
  );
}
