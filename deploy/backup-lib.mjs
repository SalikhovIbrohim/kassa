// What deploy/backup.mjs and deploy/restore.mjs share: reading the settings file, finding the
// PostgreSQL command line tools, naming and listing copies. Not meant to be run on its own.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";

/** Something the person running the script can fix: said in plain words, without a stack trace. */
export class Problem extends Error {}

/**
 * The settings file, read the way `node --env-file` (and so the services) read it. The text it was read from
 * is kept as `.raw` (not one of the settings), for the checks that look at how a value was written.
 */
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
  const settings = parseEnv(text);
  Object.defineProperty(settings, "raw", { value: text, enumerable: false });
  return settings;
}

/**
 * The folder the copies go to: --to, else BACKUP_DIR of the settings file, else the folder the caller names
 * as its own default. Checked, because a scheduled task runs where nobody can see what went wrong.
 */
export function backupFolder({ to, settings, defaultFolder }) {
  const folder = to ?? settings.BACKUP_DIR ?? defaultFolder;
  if (!folder) {
    throw new Problem("Where to put the copies? Give --to <folder>, or write BACKUP_DIR=<folder> in the settings file.");
  }
  if (/[\r\n\t]/.test(folder)) {
    throw new Problem("BACKUP_DIR contains a line break or a tab: write the path without quotes (BACKUP_DIR=D:\\kassa-copies).");
  }
  // In the file, a # that is not inside quotes starts a comment: "D:\copies #1" would be read as "D:\copies".
  if (to === undefined && /^\s*BACKUP_DIR\s*=\s*[^'"\r\n]*#/m.test(settings.raw ?? "")) {
    throw new Problem(
      "BACKUP_DIR has a # in it, and everything from the # on is read as a comment. Write the path in single quotes: BACKUP_DIR='D:\\kassa copies #1'.",
    );
  }
  if (!isAbsolute(folder)) {
    throw new Problem(`"${folder}" is not a full path (like D:\\kassa-copies): a scheduled task does not start in the folder you expect.`);
  }
  return folder;
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

/** What may follow the time in the name of a copy that has a purpose of its own: `before-update`. */
export const LABEL = /^[a-z]+(-[a-z]+)*$/;

/**
 * The names of the copies of one database. The nightly copy: `kassa-20261001-143005.dump`. One made for a
 * purpose: `kassa-20261001-143005-before-update.dump`. Without `label` only the nightly ones match; with a
 * label only the ones with that label; with `anyLabel` the ones with any (and without) label.
 */
export function copyPattern(database, { partial = false, label, anyLabel = false } = {}) {
  const tail = anyLabel ? "(?:-[a-z]+(?:-[a-z]+)*)?" : label ? `-${escapeRegExp(label)}` : "";
  return new RegExp(`^${escapeRegExp(database)}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})${tail}\\.dump${partial ? "\\.partial" : ""}$`);
}

// A copy whose name says it was made later than this from now was made by a clock that was wrong.
const FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * The copies of one kind (see copyPattern) in a folder, newest first by the time in their names. Other files
 * are not copies and are not listed. A copy dated in the future (the clock of the computer was wrong when it
 * was made) is not among them: it would sort as the newest for ever, keep the real copies from being counted
 * and make the check of the nightly copy look at the wrong one. Those are in `future`; nothing deletes them.
 */
export async function listCopies(folder, database, { label, now = new Date() } = {}) {
  const names = await readdir(folder).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const pattern = copyPattern(database, { label });
  const copies = [];
  const future = [];
  for (const name of names.sort().reverse()) {
    const match = pattern.exec(name);
    if (!match) continue;
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const named = new Date(year, month - 1, day, hour, minute, second).getTime();
    (named > now.getTime() + FUTURE_MS ? future : copies).push({ name, path, size: info.size, modifiedMs: info.mtimeMs });
  }
  return { copies, future };
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
