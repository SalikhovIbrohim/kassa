import { createHash, randomBytes } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { hashPassword, verifyPassword } from "./passwords.js";

export const SESSION_COOKIE = "kassa_session";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Role = "cashier" | "viewer";

export type SessionUser = {
  id: string;
  login: string;
  displayName: string;
  role: Role;
};

export type AuthOptions = {
  pool: pg.Pool;
  now: () => Date;
  sessionDays: number;
  secureCookies: boolean;
};

type UserRow = {
  id: string;
  login: string;
  display_name: string;
  password_hash: string;
  role: Role;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `app.authenticate`: the person behind the session cookie. */
    user?: SessionUser;
  }
  interface FastifyInstance {
    /** preHandler that answers 401 unless the request carries a valid session. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export async function registerAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { pool, now, sessionDays, secureCookies } = options;
  // Extend at most once a day, but often enough that a short lifetime still slides.
  const refreshAfterMs = Math.min(DAY_MS, (sessionDays * DAY_MS) / 4);

  await app.register(fastifyCookie);

  // Warm up now so the very first unknown-login attempt is not slower than the rest.
  unknownUserHash().catch(() => {});

  function setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      maxAge: sessionDays * DAY_MS / 1000,
    });
  }

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await findSession(token) : undefined;
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.user = session.user;

    // Sliding expiry: someone who uses the app never has to log in again. The write
    // is throttled to once a day, and the cookie is re-sent so the browser keeps up.
    const current = now();
    if (current.getTime() - session.lastSeenAt.getTime() >= refreshAfterMs) {
      await pool.query(
        "UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1",
        [session.id, current, new Date(current.getTime() + sessionDays * DAY_MS)],
      );
      setSessionCookie(reply, token!);
    }
  });

  async function findSession(
    token: string,
  ): Promise<{ id: string; lastSeenAt: Date; user: SessionUser } | undefined> {
    const result = await pool.query<UserRow & { session_id: string; last_seen_at: Date }>(
      `SELECT s.id AS session_id, s.last_seen_at, u.id, u.login, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active`,
      [hashToken(token), now()],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.session_id,
      lastSeenAt: row.last_seen_at,
      user: { id: row.id, login: row.login, displayName: row.display_name, role: row.role },
    };
  }

  app.get("/api/me", { preHandler: app.authenticate }, async (request) => {
    const { login, displayName, role } = request.user!;
    return { user: { login, displayName, role } };
  });

  app.post("/api/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.post<{ Body: { login: string; password: string } }>(
    "/api/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["login", "password"],
          additionalProperties: false,
          properties: {
            login: { type: "string", minLength: 1, maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await pool.query<UserRow>(
        `SELECT id, login, display_name, password_hash, role
           FROM users WHERE lower(login) = lower($1) AND active`,
        [request.body.login.trim()],
      );
      const user = result.rows[0];
      // Spend the same time whether or not the login exists, so response time
      // does not reveal which logins are real.
      const passwordHash = user?.password_hash ?? (await unknownUserHash());
      const passwordMatches = await verifyPassword(request.body.password, passwordHash);
      if (!user || !passwordMatches) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const token = randomBytes(32).toString("base64url");
      const started = now();
      // Only if the account is still active and the password is still the one we just
      // checked: a reset or revoke that raced with this login must not be outlived by it.
      const created = await pool.query(
        `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
         SELECT id, $2, $3, $3, $4 FROM users
          WHERE id = $1 AND active AND password_hash = $5`,
        [
          user.id,
          hashToken(token),
          started,
          new Date(started.getTime() + sessionDays * DAY_MS),
          user.password_hash,
        ],
      );
      if (created.rowCount === 0) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      // Housekeeping: expired sessions are useless, drop them as people log in.
      await pool.query("DELETE FROM sessions WHERE expires_at <= $1", [started]);

      setSessionCookie(reply, token);
      return {
        user: { login: user.login, displayName: user.display_name, role: user.role },
      };
    },
  );
}

let unknownUserHashPromise: Promise<string> | undefined;

/** A real hash of a throwaway password, computed once, to burn the same time as a real check. */
function unknownUserHash(): Promise<string> {
  unknownUserHashPromise ??= hashPassword(randomBytes(16).toString("hex"));
  return unknownUserHashPromise;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
