import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  host: string;
  port: number;
  databaseUrl: string;
  /** Folder with the built web app, or undefined when there is none. */
  webDistDir: string | undefined;
  /** Session cookie only over HTTPS. On in production, off for plain-HTTP development. */
  secureCookies: boolean;
  /** How many days a session lives without use. */
  sessionDays: number;
  /** Reverse proxies whose X-Forwarded-For is believed; undefined when none is trusted. */
  trustProxy: string[] | undefined;
  /** Start even though a newer version changed the database (see `migrate`). An emergency switch. */
  allowNewerSchema: boolean;
  /** The Telegram bot of the Mini App. Unset: signing in inside Telegram is off. */
  telegramBotToken: string | undefined;
  /** The Telegram group that is told about the incomes of clients (its number, negative). Unset: nothing is sent. */
  telegramGroupChatId: string | undefined;
  /** The topic of that group that gets the messages, when it has topics; unset: the main topic. */
  telegramGroupThreadId: number | undefined;
  /** The address of the Bot API; only a test or a proxy sets it. */
  telegramApiUrl: string;
};

// server/src/config.ts and server/dist/config.js both sit two levels below the repo root.
const defaultWebDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (see .env.example)");
  }

  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}"`);
  }

  const sessionDays = env.SESSION_DAYS ? Number(env.SESSION_DAYS) : 90;
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 3650) {
    throw new Error(`SESSION_DAYS must be a whole number of days, got "${env.SESSION_DAYS}"`);
  }

  if (env.COOKIE_SECURE && env.COOKIE_SECURE !== "true" && env.COOKIE_SECURE !== "false") {
    throw new Error(`COOKIE_SECURE must be "true" or "false", got "${env.COOKIE_SECURE}"`);
  }
  const secureCookies = env.COOKIE_SECURE
    ? env.COOKIE_SECURE === "true"
    : env.NODE_ENV === "production";

  const trustedProxies = (env.TRUST_PROXY ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  // A group has a negative number (a supergroup one that starts with -100); a channel too. Not a name: the bot cannot find a group by it.
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID?.trim() || undefined;
  if (groupChatId !== undefined && !/^-?[0-9]{5,20}$/.test(groupChatId)) {
    throw new Error(`TELEGRAM_GROUP_CHAT_ID must be the number of the group, like -1001234567890, got "${groupChatId}"`);
  }

  const threadText = env.TELEGRAM_GROUP_THREAD_ID?.trim();
  const groupThreadId = threadText ? Number(threadText) : undefined;
  if (groupThreadId !== undefined && (!Number.isInteger(groupThreadId) || groupThreadId < 1)) {
    throw new Error(`TELEGRAM_GROUP_THREAD_ID must be the number of the topic, like 3, got "${threadText}"`);
  }

  const webDistDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : defaultWebDistDir;

  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    databaseUrl,
    webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
    secureCookies,
    sessionDays,
    trustProxy: trustedProxies.length > 0 ? trustedProxies : undefined,
    allowNewerSchema: env.ALLOW_NEWER_SCHEMA === "1",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramGroupChatId: groupChatId,
    telegramGroupThreadId: groupThreadId,
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
  };
}
