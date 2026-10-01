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
  };
}
