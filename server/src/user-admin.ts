import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { assertPassword, LOGIN_PATTERN, ROLES, type Role } from "./admin/users.js";
import { inTransaction } from "./ledger.js";
import { hashPassword } from "./passwords.js";
import { NO_NUL, NO_QUERY, UUID } from "./schemas.js";
import { cleanText } from "./text.js";

export type UserAdminOptions = {
  pool: pg.Pool;
};

type UserRow = { id: string; login: string; display_name: string; role: Role; active: boolean; created_at: Date; has_entries: boolean };

const USER_SELECT = `SELECT u.id, u.login, u.display_name, u.role, u.active, u.created_at,
       (EXISTS (SELECT 1 FROM operations o WHERE o.author_id = u.id OR o.deleted_by = u.id)
        OR EXISTS (SELECT 1 FROM operation_changes c WHERE c.changed_by = u.id)
        OR EXISTS (SELECT 1 FROM reconciliations r WHERE r.made_by = u.id)
        OR EXISTS (SELECT 1 FROM shifts s WHERE s.cashier_id = u.id OR s.closed_by = u.id)) AS has_entries
  FROM users u`;

const toUser = (row: UserRow) => ({
  id: row.id,
  login: row.login,
  displayName: row.display_name,
  role: row.role,
  active: row.active,
  createdAt: row.created_at.toISOString(),
  // A user who wrote anything stays in the base, so that the journal keeps saying who; they can only be blocked.
  hasEntries: row.has_entries,
});

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

const loginProperty = { type: "string", minLength: 1, maxLength: 64 } as const;
const nameProperty = { type: "string", minLength: 1, maxLength: 60, pattern: NO_NUL } as const;
const passwordProperty = { type: "string", minLength: 1, maxLength: 1024 } as const;
const roleProperty = { type: "string", enum: [...ROLES] } as const;

/** Says what is wrong with a login or a password, or nothing. */
function badInput(input: { login?: string; password?: string }): string | null {
  if (input.login !== undefined && !LOGIN_PATTERN.test(input.login)) return "bad_login";
  if (input.password !== undefined) {
    try {
      assertPassword(input.password);
    } catch {
      return "bad_password";
    }
  }
  return null;
}

/**
 * The accounts of the cash desk, kept by the admin from the screen: adds a person, gives a role, changes the login,
 * the name and the password, blocks and unblocks, and deletes one who never wrote anything. The admin cannot take
 * away his own role, block or delete himself, so that the desk is never left without an admin.
 */
export async function registerUserAdmin(app: FastifyInstance, options: UserAdminOptions) {
  const { pool } = options;
  const admin = [app.authenticate, app.requireRole("admin")];
  const params = { type: "object", required: ["id"], properties: { id: UUID } } as const;

  const readUser = async (client: pg.Pool | pg.ClientBase, id: string) =>
    (await client.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0];

  app.get("/api/admin/users", { onRequest: admin, schema: { querystring: NO_QUERY } }, async () => {
    const rows = await pool.query<UserRow>(`${USER_SELECT} ORDER BY u.active DESC, lower(u.display_name), lower(u.login)`);
    return { users: rows.rows.map(toUser) };
  });

  app.post<{ Body: { login: string; displayName?: string; password: string; role: Role } }>(
    "/api/admin/users",
    {
      onRequest: admin,
      schema: {
        querystring: NO_QUERY,
        body: {
          type: "object",
          required: ["login", "password", "role"],
          additionalProperties: false,
          properties: { login: loginProperty, displayName: nameProperty, password: passwordProperty, role: roleProperty },
        },
      },
    },
    async (request, reply) => {
      const login = request.body.login.trim();
      const problem = badInput({ login, password: request.body.password });
      if (problem) return reply.code(400).send({ error: problem });
      const displayName = cleanText(request.body.displayName ?? "") || login;
      const passwordHash = await hashPassword(request.body.password);
      try {
        const inserted = await pool.query<{ id: string }>(
          "INSERT INTO users (login, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id",
          [login, displayName, passwordHash, request.body.role],
        );
        return reply.code(201).send({ user: toUser((await readUser(pool, inserted.rows[0]!.id))!) });
      } catch (error) {
        if (codeOf(error) === UNIQUE_VIOLATION) return reply.code(409).send({ error: "login_taken" });
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { login?: string; displayName?: string; role?: Role; password?: string; active?: boolean } }>(
    "/api/admin/users/:id",
    {
      onRequest: admin,
      schema: {
        querystring: NO_QUERY,
        params,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { login: loginProperty, displayName: nameProperty, role: roleProperty, password: passwordProperty, active: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const login = body.login?.trim();
      const displayName = body.displayName === undefined ? undefined : cleanText(body.displayName);
      if (displayName === "") return reply.code(400).send({ error: "bad_name" });
      const problem = badInput({ login, password: body.password });
      if (problem) return reply.code(400).send({ error: problem });
      const self = id === request.user!.id;
      if (self && ((body.role !== undefined && body.role !== "admin") || body.active === false)) {
        return reply.code(409).send({ error: "self" });
      }
      const passwordHash = body.password === undefined ? null : await hashPassword(body.password);
      try {
        const result = await inTransaction(pool, async (client) => {
          const before = await readUser(client, id);
          if (!before) return null;
          await client.query(
            `UPDATE users SET login = COALESCE($2, login), display_name = COALESCE($3, display_name), role = COALESCE($4, role),
                    password_hash = COALESCE($5, password_hash), active = COALESCE($6, active)
              WHERE id = $1`,
            [id, login ?? null, displayName ?? null, body.role ?? null, passwordHash, body.active ?? null],
          );
          // A new password or a block ends every session of the person, as after a lost phone.
          if (passwordHash !== null || body.active === false) await client.query("DELETE FROM sessions WHERE user_id = $1", [id]);
          return readUser(client, id);
        });
        if (!result) return reply.code(404).send({ error: "not_found" });
        return { user: toUser(result) };
      } catch (error) {
        if (codeOf(error) === UNIQUE_VIOLATION) return reply.code(409).send({ error: "login_taken" });
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/users/:id", { onRequest: admin, schema: { querystring: NO_QUERY, params } }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user!.id) return reply.code(409).send({ error: "self" });
    try {
      const deleted = await pool.query("DELETE FROM users WHERE id = $1", [id]);
      if (deleted.rowCount === 0) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    } catch (error) {
      // Whoever wrote, changed or counted anything is named in the journal: such an account is only blocked.
      if (codeOf(error) === FOREIGN_KEY_VIOLATION) return reply.code(409).send({ error: "has_entries" });
      throw error;
    }
  });
}
