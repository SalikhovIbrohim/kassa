import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  host: string;
  port: number;
  databaseUrl: string;
  /** Folder with the built web app, or undefined when there is none. */
  webDistDir: string | undefined;
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

  const webDistDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : defaultWebDistDir;

  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    databaseUrl,
    webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
  };
}
