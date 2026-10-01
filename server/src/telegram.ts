import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";

/** How old the launch data of a Mini App may be. A signed copy that was taken is useless after this. */
export const MAX_AGE_SECONDS = 3600;
/** A clock that is a little ahead of ours is no reason to refuse. */
const CLOCK_SKEW_SECONDS = 60;

export type InitData =
  | { ok: true; telegramId: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "stale" };

/**
 * Checks what Telegram hands to a Mini App when it opens (`initData`): that it was signed with the key of this bot,
 * and that it is recent. The rule is Telegram's own: the fields except `hash` sorted by name and written
 * `name=value` one per line are signed with HMAC-SHA256 under a key that is itself the HMAC of the bot's token
 * under the word "WebAppData". Nothing in it is believed before the signature agrees.
 */
export function checkInitData(initData: string, botToken: string, nowMs: number): InitData {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "malformed" };
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  const age = nowMs / 1000 - authDate;
  if (!Number.isFinite(authDate) || age > MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) return { ok: false, reason: "stale" };

  let user: unknown;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const id = (user as { id?: unknown } | null)?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "malformed" };
  return { ok: true, telegramId: id };
}

export type TelegramOptions = {
  pool: pg.Pool;
  now: () => Date;
  /** The token of the bot whose Mini App this is. Without it Telegram sign-in is off. */
  botToken: string | undefined;
};

const BODY = {
  type: "object",
  required: ["initData"],
  additionalProperties: false,
  properties: { initData: { type: "string", minLength: 1, maxLength: 4096 } },
} as const;

/**
 * Signing in inside Telegram, and linking a Telegram account to a login. The browser version never needs any of it.
 * An account that is not linked gets nothing here: it must sign in with its password first, and link from inside
 * Telegram (the only place where the signed data exists).
 */
export async function registerTelegram(app: FastifyInstance, options: TelegramOptions) {
  const { pool, now, botToken } = options;

  const verified = (initData: string) => (botToken ? checkInitData(initData, botToken, now().getTime()) : null);

  app.post<{ Body: { initData: string } }>("/api/telegram/login", { schema: { body: BODY } }, async (request, reply) => {
    const checked = verified(request.body.initData);
    if (checked === null) return reply.code(404).send({ error: "telegram_disabled" });
    if (!checked.ok) {
      return reply.code(401).send({ error: checked.reason === "stale" ? "stale_telegram_data" : "invalid_telegram_data" });
    }
    const found = await pool.query<{ id: string; login: string; display_name: string; role: string }>(
      "SELECT id, login, display_name, role FROM users WHERE telegram_id = $1 AND active",
      [checked.telegramId],
    );
    const user = found.rows[0];
    if (!user) return reply.code(403).send({ error: "telegram_not_linked" });
    if (!(await app.startSession(reply, user.id))) return reply.code(403).send({ error: "telegram_not_linked" });
    return { user: { login: user.login, displayName: user.display_name, role: user.role, telegramLinked: true } };
  });

  app.post<{ Body: { initData: string } }>(
    "/api/telegram/link",
    { onRequest: app.authenticate, schema: { body: BODY } },
    async (request, reply) => {
      const checked = verified(request.body.initData);
      if (checked === null) return reply.code(404).send({ error: "telegram_disabled" });
      if (!checked.ok) {
        return reply.code(401).send({ error: checked.reason === "stale" ? "stale_telegram_data" : "invalid_telegram_data" });
      }
      try {
        await pool.query("UPDATE users SET telegram_id = $2 WHERE id = $1", [request.user!.id, checked.telegramId]);
      } catch (error) {
        // The unique index: this Telegram account belongs to another login.
        if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "telegram_taken" });
        throw error;
      }
      return reply.code(204).send();
    },
  );

  app.delete("/api/telegram/link", { onRequest: app.authenticate }, async (request, reply) => {
    await pool.query("UPDATE users SET telegram_id = NULL WHERE id = $1", [request.user!.id]);
    return reply.code(204).send();
  });
}
