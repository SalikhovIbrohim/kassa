import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientCodeOf } from "./onec-pko.js";
import type { OneCSettings } from "./onec-api.js";

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
  /** The topics of that group that get the messages about incomes and about expenses, when it has topics; unset: the main topic. */
  telegramIncomeThreadId: number | undefined;
  telegramExpenseThreadId: number | undefined;
  /** The address of the Bot API; only a test or a proxy sets it. */
  telegramApiUrl: string;
  /** The 1C base the payments of clients are written to. Unset: nothing is written. */
  onec: OneCSettings | undefined;
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

  const threadOf = (name: string): number | undefined => {
    const text = env[name]?.trim();
    if (!text) return undefined;
    const number = Number(text);
    if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be the number of the topic, like 3, got "${text}"`);
    return number;
  };

  const onec = loadOneC(env);

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
    telegramIncomeThreadId: threadOf("TELEGRAM_THREAD_INCOME"),
    telegramExpenseThreadId: threadOf("TELEGRAM_THREAD_EXPENSE"),
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    onec,
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The settings of the writing to 1C. `COSMO_1C_MODE` is off (the default), `preview` (says what would be written) or `live`. */
export function loadOneC(env: NodeJS.ProcessEnv): OneCSettings | undefined {
  const mode = env.COSMO_1C_MODE?.trim().toLowerCase() || "off";
  if (mode === "off") return undefined;
  if (mode !== "preview" && mode !== "live") throw new Error(`COSMO_1C_MODE must be off, preview or live, got "${env.COSMO_1C_MODE}"`);

  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when COSMO_1C_MODE is ${mode}`);
    return value;
  };
  const key = (name: string) => {
    const value = need(name);
    if (!GUID.test(value)) throw new Error(`${name} must be a key like 0d2cb474-924a-11f1-8cb7-b8cb29f61f4c`);
    return value.toLowerCase();
  };
  const clients = (env.COSMO_1C_CLIENTS ?? "")
    .split(",")
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => {
      const code = clientCodeOf(text);
      if (!code) throw new Error(`COSMO_1C_CLIENTS must list codes of clients like А339, got "${text}"`);
      return code.code;
    });

  return {
    url: need("COSMO_ODATA_URL"),
    user: need("COSMO_ODATA_USER"),
    password: need("COSMO_ODATA_PASSWORD"),
    organizationKey: key("COSMO_1C_ORGANIZATION_KEY"),
    kassaKey: key("COSMO_1C_KASSA_KEY"),
    currencyKey: key("COSMO_1C_CURRENCY_KEY"),
    mode,
    onlyClients: clients.length > 0 ? clients : undefined,
  };
}
