import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKassas, type Kassa, type Kassas } from "./kassa.js";
import { clientCodeExample, parseClientCodes, type ClientCodes } from "./clients.js";
import { clientCodeOf } from "./onec-pko.js";
import type { OneCSettings } from "./onec-api.js";
import { cashDayStart } from "./cash-day.js";
import { readServiceAccountKey, type SheetSettings } from "./sheets-api.js";
import { parseWarehouses, type Warehouses } from "./warehouses.js";

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
  /** The cash desks of the business (`KASSAS`): Moscow in rubles and dollars and Andijan in dollars, unless set. */
  kassas: Kassas;
  /** How the business writes the codes of its clients (`CLIENT_CODES`): «А707» unless set, or digits alone. */
  clientCodes: ClientCodes;
  /** The warehouses where cargo is put on the trucks (`WAREHOUSES`). None unless set: then the business keeps no trips. */
  warehouses: Warehouses;
  /** The Telegram bot of the Mini App. Unset: signing in inside Telegram is off. */
  telegramBotToken: string | undefined;
  /** The Telegram group that is told about the incomes of clients (its number, negative). Unset: nothing is sent. */
  telegramGroupChatId: string | undefined;
  /** The topics of that group that get the messages about incomes and about expenses, when it has topics; unset: the main topic. */
  telegramIncomeThreadId: number | undefined;
  telegramExpenseThreadId: number | undefined;
  /** The topic of a cash desk, by the id of the desk (`TELEGRAM_THREAD_<ID>`, as in TELEGRAM_THREAD_ANDIJAN): all its messages. */
  telegramKassaThreadIds: Record<string, number>;
  /** The address of the Bot API; only a test or a proxy sets it. */
  telegramApiUrl: string;
  /** The 1C base the payments of clients are written to. Unset: nothing is written. */
  onec: OneCSettings | undefined;
  /** The cash desks whose payments of clients go to 1C (`ONEC_KASSAS`): the main desk, unless set. */
  onecKassas: readonly Kassa[];
  /** The Google spreadsheet the journal is copied to. Unset: nothing is copied. */
  sheet: SheetSettings | undefined;
  /** Why the copy to the spreadsheet is off although it is set up (a key that cannot be read): said in the log at start. */
  sheetProblem: string | undefined;
  /** What looks like a slip in the settings and does not keep the server from starting: said in the log at start. */
  warnings: string[];
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

  // The cash desks of the business; everything that is set per desk is named after the id of the desk.
  const kassas = parseKassas(env.KASSAS);
  const telegramKassaThreadIds: Record<string, number> = {};
  for (const id of kassas.ids) {
    const thread = threadOf(kassaSettingName("TELEGRAM_THREAD", id));
    if (thread !== undefined) telegramKassaThreadIds[id] = thread;
  }
  // A topic set for a desk the business does not have (a slip of the hand in the name): its messages go elsewhere.
  const warnings = strangerSettings(env, "TELEGRAM_THREAD", kassas, ["TELEGRAM_THREAD_INCOME", "TELEGRAM_THREAD_EXPENSE"]).map(
    (name) => `${name} is not used: the cash desks are ${kassas.ids.join(", ")} (KASSAS), and the topic of a desk is named ${kassaSettingName("TELEGRAM_THREAD", kassas.primary)}`,
  );

  const onec = loadOneC(env, kassas);

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
    kassas,
    clientCodes: parseClientCodes(env.CLIENT_CODES),
    warehouses: parseWarehouses(env.WAREHOUSES),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramGroupChatId: groupChatId,
    telegramIncomeThreadId: threadOf("TELEGRAM_THREAD_INCOME"),
    telegramExpenseThreadId: threadOf("TELEGRAM_THREAD_EXPENSE"),
    telegramKassaThreadIds,
    telegramApiUrl: (env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    onec,
    onecKassas: loadOneCKassas(env, kassas),
    ...sheetOrProblem(env),
    warnings,
  };
}

/**
 * The settings of a family that is set per cash desk (TELEGRAM_THREAD_<ID>) whose ending names no desk: a slip of the
 * hand in the name of one. `others` are the settings of the same beginning that are not about a desk.
 */
export function strangerSettings(env: NodeJS.ProcessEnv, prefix: string, kassas: Kassas, others: readonly string[] = []): string[] {
  const known = new Set([...others, ...kassas.ids.map((id) => kassaSettingName(prefix, id))]);
  return Object.keys(env)
    .filter((name) => name.toUpperCase().startsWith(`${prefix}_`) && !known.has(name.toUpperCase()) && env[name]?.trim())
    .sort();
}

/** The name of a setting that is set per cash desk: TELEGRAM_THREAD and the desk "andijan" make TELEGRAM_THREAD_ANDIJAN. */
export function kassaSettingName(prefix: string, id: Kassa): string {
  return `${prefix}_${id.toUpperCase()}`;
}

/**
 * The cash desks whose payments of clients are written to 1C: `ONEC_KASSAS`, their ids separated by commas. Without
 * it, the main desk only (the first of `KASSAS`), which is how it was while there was one company.
 */
export function loadOneCKassas(env: NodeJS.ProcessEnv, kassas: Kassas = parseKassas(env.KASSAS)): Kassa[] {
  const text = env.ONEC_KASSAS?.trim();
  if (!text) return [kassas.primary];
  const ids = text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  for (const id of ids) {
    if (!kassas.has(id)) throw new Error(`ONEC_KASSAS must list cash desks of KASSAS (${kassas.ids.join(", ")}), got "${id}"`);
  }
  return [...new Set(ids)];
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
    // The service of a second installation on the machine is named after it (INSTANCE, see deploy/windows/common.ps1).
    const service = env.INSTANCE?.trim() ? `KassaApp-${env.INSTANCE.trim()}` : "KassaApp";
    throw new Error(`GOOGLE_SHEETS_KEY_FILE: the file ${keyFile} cannot be read (is it there, and may the service read it? icacls "${keyFile}" /grant "NT SERVICE\\${service}:R")`);
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

/**
 * The settings of the writing to 1C, each with the name it had while the cash desk served one company only. A settings
 * file written then needs no change: a setting that is not there under its own name is read under the earlier one.
 */
const ONEC_EARLIER_NAMES = {
  ONEC_MODE: "COSMO_1C_MODE",
  ONEC_SEND: "COSMO_1C_SEND",
  ONEC_CLIENTS: "COSMO_1C_CLIENTS",
  ONEC_ODATA_URL: "COSMO_ODATA_URL",
  ONEC_ODATA_USER: "COSMO_ODATA_USER",
  ONEC_ODATA_PASSWORD: "COSMO_ODATA_PASSWORD",
  ONEC_ORGANIZATION_KEY: "COSMO_1C_ORGANIZATION_KEY",
  ONEC_KASSA_KEY: "COSMO_1C_KASSA_KEY",
  ONEC_CURRENCY_KEY: "COSMO_1C_CURRENCY_KEY",
} as const;

export type OneCSettingName = keyof typeof ONEC_EARLIER_NAMES;

/**
 * A setting of the writing to 1C: its value, and the name it was found under, which is the name a message about it
 * says. Not set at all, it is undefined under its own name.
 */
export function onecSetting(env: NodeJS.ProcessEnv, name: OneCSettingName): { name: string; value: string | undefined } {
  if (env[name] !== undefined) return { name, value: env[name] };
  const earlier = ONEC_EARLIER_NAMES[name];
  if (env[earlier] !== undefined) return { name: earlier, value: env[earlier] };
  return { name, value: undefined };
}

/**
 * The settings of the writing to 1C. `ONEC_MODE` is off (the default), `preview` (says what would be written) or `live`.
 * `ONEC_KASSA_KEY` is the cash desk in the base that the payments go to; a cash desk of the installation that has one
 * of its own there names it in `ONEC_KASSA_KEY_<ID>` (ONEC_KASSA_KEY_TASHKENT).
 */
export function loadOneC(env: NodeJS.ProcessEnv, kassas: Kassas = parseKassas(env.KASSAS)): OneCSettings | undefined {
  const modeSetting = onecSetting(env, "ONEC_MODE");
  const mode = modeSetting.value?.trim().toLowerCase() || "off";
  if (mode === "off") return undefined;
  if (mode !== "preview" && mode !== "live") throw new Error(`${modeSetting.name} must be off, preview or live, got "${modeSetting.value}"`);

  // A file that turns the writing on under the earlier name is told what it lacks by the earlier names too.
  const earlier = modeSetting.name !== "ONEC_MODE";
  const read = (name: OneCSettingName) => {
    const setting = onecSetting(env, name);
    return setting.value === undefined && earlier ? { name: ONEC_EARLIER_NAMES[name], value: undefined } : setting;
  };
  const need = (name: OneCSettingName) => {
    const setting = read(name);
    const value = setting.value?.trim();
    if (!value) throw new Error(`${setting.name} is required when ${modeSetting.name} is ${mode}`);
    return { name: setting.name, value };
  };
  const key = (name: OneCSettingName) => {
    const setting = need(name);
    if (!GUID.test(setting.value)) throw new Error(`${setting.name} must be a key like 0d2cb474-924a-11f1-8cb7-b8cb29f61f4c`);
    return setting.value.toLowerCase();
  };
  const sendSetting = read("ONEC_SEND");
  const send = sendSetting.value?.trim().toLowerCase() || "night";
  if (send !== "night" && send !== "now") throw new Error(`${sendSetting.name} must be night or now, got "${sendSetting.value}"`);
  const clientCodes = parseClientCodes(env.CLIENT_CODES);
  const clientsSetting = read("ONEC_CLIENTS");
  const clients = (clientsSetting.value ?? "")
    .split(",")
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => {
      const code = clientCodeOf(text, clientCodes);
      if (!code) throw new Error(`${clientsSetting.name} must list codes of clients like ${clientCodeExample(clientCodes)}, got "${text}"`);
      return code.code;
    });

  const creating = env.ONEC_CREATE_CLIENTS?.trim().toLowerCase() ?? "";
  if (!["", "yes", "no"].includes(creating)) throw new Error(`ONEC_CREATE_CLIENTS must be yes or no, got "${env.ONEC_CREATE_CLIENTS}"`);
  const createClients = creating === "yes";

  const writing = loadOneCKassas(env, kassas);
  // A key under the name of a desk that is not one (ONEC_KASSA_KEY_TASHKNET) would be left unread, and the payments of
  // the desk it was meant for would go to the cash desk of ONEC_KASSA_KEY: a wrong book in 1C, so not a start at all.
  const strangers = strangerSettings(env, "ONEC_KASSA_KEY", kassas);
  if (strangers.length > 0) {
    throw new Error(`${strangers.join(", ")} names no cash desk of KASSAS (${kassas.ids.join(", ")}): the key of a desk is set as ${kassaSettingName("ONEC_KASSA_KEY", kassas.primary)}`);
  }
  const kassaKeys: Record<string, string> = {};
  for (const id of kassas.ids) {
    const name = kassaSettingName("ONEC_KASSA_KEY", id);
    const value = env[name]?.trim();
    if (!value) continue;
    // A key nobody would use is a mistake in the file, not a wish: the payments of that desk would stay out of 1C.
    if (!writing.includes(id)) throw new Error(`${name} is set, but the payments of the cash desk ${id} are not written to 1C: name it in ONEC_KASSAS (now: ${writing.join(", ")})`);
    if (!GUID.test(value)) throw new Error(`${name} must be a key like 0d2cb474-924a-11f1-8cb7-b8cb29f61f4c`);
    kassaKeys[id] = value.toLowerCase();
  }

  return {
    url: need("ONEC_ODATA_URL").value,
    user: need("ONEC_ODATA_USER").value,
    password: need("ONEC_ODATA_PASSWORD").value,
    organizationKey: key("ONEC_ORGANIZATION_KEY"),
    kassaKey: key("ONEC_KASSA_KEY"),
    currencyKey: key("ONEC_CURRENCY_KEY"),
    ...(Object.keys(kassaKeys).length > 0 ? { kassaKeys } : {}),
    mode,
    onlyClients: clients.length > 0 ? clients : undefined,
    send,
    ...(createClients ? { createClients } : {}),
  };
}
