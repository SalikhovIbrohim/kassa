import type pg from "pg";
import { hashPassword } from "../passwords.js";

export type Role = "cashier" | "viewer";

/** A problem the developer can fix by changing the command (bad input, unknown login). */
export class AdminError extends Error {}

export type CreateUserInput = {
  login: string;
  password: string;
  role: Role;
  displayName?: string;
};

export type CreatedUser = {
  id: string;
  login: string;
  displayName: string;
  role: Role;
};

const LOGIN_PATTERN = /^[\p{L}\p{N}._-]{2,64}$/u;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

export function normalizeLogin(login: string): string {
  return login.trim();
}

export async function createUser(pool: pg.Pool, input: CreateUserInput): Promise<CreatedUser> {
  const login = normalizeLogin(input.login);
  if (!LOGIN_PATTERN.test(login)) {
    throw new AdminError("Login must be 2-64 characters: letters, digits, dot, dash, underscore");
  }
  assertPassword(input.password);
  if (input.role !== "cashier" && input.role !== "viewer") {
    throw new AdminError('Role must be "cashier" or "viewer"');
  }
  const displayName = input.displayName?.trim() || login;

  const passwordHash = await hashPassword(input.password);
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (login, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [login, displayName, passwordHash, input.role],
    );
    return { id: result.rows[0]!.id, login, displayName, role: input.role };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AdminError(`A user with login "${login}" already exists`);
    }
    throw error;
  }
}

export function assertPassword(password: string): void {
  // Count characters the way the login API and the hashing do: normalised, by code point.
  const length = [...password.normalize("NFKC")].length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new AdminError(
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters long`,
    );
  }
}

export async function revokeUser(pool: pg.Pool, login: string): Promise<void> {
  const userId = await findUserId(pool, login);
  // One transaction: no moment when the user is blocked but a session still works, or the reverse.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET active = false WHERE id = $1", [userId]);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Gives access back. The user has to log in again: old sessions stay gone. */
export async function restoreUser(pool: pg.Pool, login: string): Promise<void> {
  const userId = await findUserId(pool, login);
  await pool.query("UPDATE users SET active = true WHERE id = $1", [userId]);
}

/** Sets a new password and ends every session, as after a lost phone. Does not restore access. */
export async function resetPassword(
  pool: pg.Pool,
  login: string,
  newPassword: string,
): Promise<void> {
  const userId = await findUserId(pool, login);
  assertPassword(newPassword);
  const passwordHash = await hashPassword(newPassword);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ListedUser = {
  login: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: Date;
};

export async function listUsers(pool: pg.Pool): Promise<ListedUser[]> {
  const result = await pool.query<{
    login: string;
    display_name: string;
    role: Role;
    active: boolean;
    created_at: Date;
  }>("SELECT login, display_name, role, active, created_at FROM users ORDER BY lower(login)");
  return result.rows.map((row) => ({
    login: row.login,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  }));
}

async function findUserId(pool: pg.Pool, login: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(login) = lower($1)",
    [normalizeLogin(login)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AdminError(`No user with login "${normalizeLogin(login)}"`);
  }
  return row.id;
}
