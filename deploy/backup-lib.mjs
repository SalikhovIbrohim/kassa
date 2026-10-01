// What deploy/backup.mjs and deploy/restore.mjs share: reading the settings file, finding the
// PostgreSQL command line tools, naming and listing copies. Not meant to be run on its own.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { parseEnv } from "node:util";

/** Something the person running the script can fix: said in plain words, without a stack trace. */
export class Problem extends Error {}

/** The settings file, read the way `node --env-file` (and so the services) read it. */
export async function readSettings(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Problem(
      `Cannot read the settings file ${path}: ${error.code === "ENOENT" ? "it does not exist" : error.message}` +
        (error.code === "EACCES" || error.code === "EPERM" ? " (run this as an administrator)" : ""),
    );
  }
  return parseEnv(text);
}

/** The parts of DATABASE_URL, decoded. */
export function connectionFrom(settings, path) {
  const text = settings.DATABASE_URL;
  if (!text) throw new Problem(`DATABASE_URL is missing from ${path}`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Problem(`DATABASE_URL in ${path} is not an address (postgres://user:password@host:port/database)`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Problem(`DATABASE_URL in ${path} must start with postgres://`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Problem(`DATABASE_URL in ${path} names no database`);
  return {
    host: url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** The environment for a PostgreSQL tool: the password goes in a variable, never on the command line. */
export function toolEnvironment(connection) {
  return {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGCONNECT_TIMEOUT: "15",
  };
}

/**
 * Finds `pg_dump` or `pg_restore`: in the folder given (--pg-bin or PG_BIN), then on the PATH, then,
 * on Windows, where the PostgreSQL installer puts them (the newest version installed).
 */
export async function findTool(name, folder) {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  if (folder) {
    const path = join(folder, file);
    if (!existsSync(path)) throw new Problem(`${file} is not in ${folder} (the folder given as --pg-bin or PG_BIN)`);
    return path;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(directory, file);
    if (existsSync(path)) return path;
  }

  if (process.platform === "win32") {
    const root = join(process.env.ProgramFiles ?? "C:\\Program Files", "PostgreSQL");
    const versions = await readdir(root).catch(() => []);
    for (const version of versions.sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))) {
      const path = join(root, version, "bin", file);
      if (existsSync(path)) return path;
    }
  }

  throw new Problem(
    `${file} was not found. It comes with PostgreSQL (the "Command Line Tools" part of the installer). ` +
      `Give the folder it is in: --pg-bin "C:\\Program Files\\PostgreSQL\\16\\bin" (or PG_BIN in the settings file).`,
  );
}

/** Runs a program and collects what it says. Rejects only when it cannot be started at all. */
export function run(command, args, { env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const two = (n) => String(n).padStart(2, "0");

/** 2026-10-01 14:30:05, for log lines. */
export function localTime(date = new Date()) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** 20261001-143005: the machine's own clock, sorts like the time does. */
export function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names of the copies of one database: `kassa-20261001-143005.dump`. */
export function copyPattern(database, { partial = false } = {}) {
  return new RegExp(`^${escapeRegExp(database)}-\\d{8}-\\d{6}\\.dump${partial ? "\\.partial" : ""}$`);
}

/** The copies of one database in a folder, newest first. Other files are not copies and are not listed. */
export async function listCopies(folder, database) {
  const names = await readdir(folder).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const pattern = copyPattern(database);
  const copies = [];
  for (const name of names.filter((item) => pattern.test(item)).sort().reverse()) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) copies.push({ name, path, size: info.size, modifiedMs: info.mtimeMs });
  }
  return copies;
}

export function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tries again a few times: on Windows a virus scanner may hold a new file for a moment. */
export async function patiently(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const busy = error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
      if (!busy || attempt >= 6) throw error;
      await sleep(250 * attempt);
    }
  }
}
