import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientCodeOf } from "./onec-pko.js";
import type { OneCSettings } from "./onec-api.js";
import { cashDayStart } from "./cash-day.js";
import { readServiceAccountKey, type SheetSettings } from "./sheets-api.js";

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
  /** The topic of the Andijan cash desk: all its messages. */
  telegramAndijanThreadId: number | undefined;
  /** The address of the Bot API; only a test or a proxy sets it. */
  telegramApiUrl: string;
  /** The 1C base the payments of clients are written to. Unset: nothing is written. */
  onec: OneCSettings | undefined;
  /** The Google spreadsheet the journal is copied to. Unset: nothing is copied. */
  sheet: SheetSettings | undefined;
  /** Why the copy to the spreadsheet is off although it is set up (a key that cannot be read): said in the log at start. */
  sheetProblem: string | undefined;
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
    telegramAndijanThreadId: threadOf("TELEGRAM_THREAD_ANDIJAN"),
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    onec,
    ...sheetOrProblem(env),
  };
}

/**
 * The copy to the spreadsheet is a side job: settings of it that are wrong turn it off, with the reason in the log,
 * and never keep the cash desk from starting.
 */
function sheetOrProblem(env: NodeJS.ProcessEnv): { sheet: SheetSettings | undefined; sheetProblem: string | undefined } {
  try {
    return { sheet: loadSheet(env), sheetProblem: undefined };
  } catch (error) {
    return { sheet: undefined, sheetProblem: (error as Error).message };
  }
}

/**
 * The copy of the journal in a Google spreadsheet: `GOOGLE_SHEET_ID` (the id in the address of the spreadsheet) and
 * `GOOGLE_SHEETS_KEY_FILE` (the JSON key of the service account it is shared with). Optional: `GOOGLE_SHEET_TAB`
 * (default «Журнал») and `GOOGLE_SHEET_FROM` (a day, 2026-10-14: only the entries from then on).
 */
export function loadSheet(env: NodeJS.ProcessEnv): SheetSettings | undefined {
  const spreadsheetId = env.GOOGLE_SHEET_ID?.trim();
  const keyFile = env.GOOGLE_SHEETS_KEY_FILE?.trim();
  if (!spreadsheetId && !keyFile) return undefined;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEET_ID is required with GOOGLE_SHEETS_KEY_FILE: the id in the address of the spreadsheet");
  if (!keyFile) throw new Error("GOOGLE_SHEETS_KEY_FILE is required with GOOGLE_SHEET_ID: the JSON key of the service account");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) throw new Error(`GOOGLE_SHEET_ID must be the id from the address of the spreadsheet (between /d/ and /edit), got "${spreadsheetId}"`);
  let text: string;
  try {
    text = readFileSync(keyFile, "utf8");
  } catch {
    throw new Error(`GOOGLE_SHEETS_KEY_FILE: the file ${keyFile} cannot be read (is it there, and may the service read it? icacls "${keyFile}" /grant "NT SERVICE\\KassaApp:R")`);
  }
  const from = env.GOOGLE_SHEET_FROM?.trim();
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`GOOGLE_SHEET_FROM must be a day like 2026-10-14, got "${from}"`);
  return {
    ...readServiceAccountKey(text),
    spreadsheetId,
    tab: env.GOOGLE_SHEET_TAB?.trim() || "Журнал",
    from: from ? cashDayStart(from) : undefined,
    apiUrl: (env.GOOGLE_SHEETS_API_URL?.trim() || "https://sheets.googleapis.com").replace(/\/+$/, ""),
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
