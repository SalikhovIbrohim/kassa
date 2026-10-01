#!/usr/bin/env node
// Makes a copy of the Kassa database: one compressed file, named after the database and the time
// (kassa-20261001-143005.dump). Meant to be run every night by the Windows Task Scheduler.
//
//   node deploy/backup.mjs --settings C:\kassa\config\kassa.env --to D:\kassa-copies
//   node deploy/backup.mjs --settings C:\kassa\config\kassa.env --status
//
// The exit code is 0 only if a good copy was made, so that the Task Scheduler shows a failure.
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  Problem,
  connectionFrom,
  copyPattern,
  findTool,
  listCopies,
  localTime,
  megabytes,
  patiently,
  readSettings,
  run,
  sleep,
  stamp,
  toolEnvironment,
} from "./backup-lib.mjs";

const USAGE = `Usage:
  node deploy/backup.mjs --settings <settings file> [--to <folder>] [--keep <number>] [--pg-bin <folder>] [--log <file>]
  node deploy/backup.mjs --settings <settings file> --status [--to <folder>] [--max-age-hours <hours>]

Makes a compressed copy of the database named by DATABASE_URL in the settings file, and puts it in the
folder given by --to, or by BACKUP_DIR in the settings file (a full path, written without quotes).
The newest 14 copies are kept (--keep, or BACKUP_KEEP); older copies of the same database are deleted,
but only after the new copy is made and checked. Nothing else in the folder is touched.
pg_dump is found on the PATH, or in the folder given by --pg-bin (or PG_BIN in the settings file).
--log adds a line to that file for every run, with the time: OK and the file made, or FAILED and why.

Exit code 0: the copy was made. 1: it was not (the reason is printed). 2: wrong use.
With --status nothing is copied: the exit code is 0 if the newest copy is not older than
--max-age-hours (default 26), and 1 if there is none or it is older.`;

const DEFAULT_KEEP = 14;
const DEFAULT_MAX_AGE_HOURS = 26;
// A database this small is copied in seconds. A copy that has not finished by then is stuck (on a
// lock, say), and a stuck copy would also keep the Task Scheduler from starting tomorrow's.
const DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let options;
try {
  options = parseArgs({
    args: process.argv.slice(2),
    options: {
      settings: { type: "string" },
      to: { type: "string" },
      keep: { type: "string" },
      "pg-bin": { type: "string" },
      log: { type: "string" },
      status: { type: "boolean" },
      "max-age-hours": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }).values;
} catch (error) {
  usageError(error.message);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!options.settings) usageError("--settings is required");

function wholeNumber(text, what, minimum) {
  const number = Number(text);
  if (!/^\d+$/.test(String(text).trim()) || number < minimum) usageError(`${what} must be a whole number, ${minimum} or more, got "${text}"`);
  return number;
}

try {
  const settingsPath = resolve(options.settings);
  const settings = await readSettings(settingsPath);
  const connection = connectionFrom(settings, settingsPath);

  const folder = options.to ?? settings.BACKUP_DIR;
  if (!folder) {
    throw new Problem("Where to put the copies? Give --to <folder>, or write BACKUP_DIR=<folder> in the settings file.");
  }
  if (/[\r\n\t]/.test(folder)) {
    throw new Problem("BACKUP_DIR contains a line break or a tab: write the path without quotes (BACKUP_DIR=D:\\kassa-copies).");
  }
  if (!isAbsolute(folder)) {
    throw new Problem(`"${folder}" is not a full path (like D:\\kassa-copies): a scheduled task does not start in the folder you expect.`);
  }

  if (options.status) {
    const maxAge = wholeNumber(options["max-age-hours"] ?? DEFAULT_MAX_AGE_HOURS, "--max-age-hours", 1);
    await status(folder, connection.database, maxAge);
  } else {
    const keep = wholeNumber(options.keep ?? settings.BACKUP_KEEP ?? DEFAULT_KEEP, "--keep (or BACKUP_KEEP)", 1);
    const made = await backup({ folder, connection, keep, pgBin: options["pg-bin"] ?? settings.PG_BIN });
    await writeLog(`OK      Copy made: ${made.path} (${megabytes(made.size)})`);
  }
} catch (error) {
  const message = error instanceof Problem ? error.message : (error?.stack ?? String(error));
  console.error(`Error: ${message}`);
  if (!options.status) await writeLog(`FAILED  ${message}`);
  process.exit(1);
}

/** One line in the log file, for whoever asks later whether the nightly copy has been working. */
async function writeLog(text) {
  if (!options.log) return;
  try {
    await mkdir(dirname(resolve(options.log)), { recursive: true });
    await appendFile(resolve(options.log), `${localTime()}  ${text.replace(/\s*\r?\n\s*/g, " | ")}\n`);
  } catch (error) {
    console.error(`Warning: could not write to the log ${options.log}: ${error.message}`);
  }
}

async function backup({ folder, connection, keep, pgBin }) {
  const pgDump = await findTool("pg_dump", pgBin);
  const pgRestore = await findTool("pg_restore", pgBin);

  try {
    // Only the people who run the server should read copies: they hold every entry and the password hashes.
    await mkdir(folder, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Problem(`Cannot create the folder ${folder}: ${error.message}`);
  }

  // The name is the time to the second. The unfinished file is made first, and only one run can make it: a
  // second copy begun in the same second (a person and the task, say) waits for the next second instead of
  // writing over the first.
  let name;
  let finalPath;
  let partial;
  for (let attempt = 0; ; attempt++) {
    name = `${connection.database}-${stamp()}.dump`;
    finalPath = join(folder, name);
    partial = `${finalPath}.partial`;
    if (!existsSync(finalPath)) {
      try {
        await (await open(partial, "wx", 0o600)).close();
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw new Problem(`Cannot create ${partial}: ${error.message}`);
      }
    }
    if (attempt >= 3) throw new Problem(`${finalPath} exists already`);
    await sleep(1100);
  }

  try {
    const dump = await run(
      pgDump,
      ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--file", partial, "--dbname", connection.database],
      { env: toolEnvironment(connection), timeoutMs: DUMP_TIMEOUT_MS },
    );
    if (dump.timedOut) throw new Problem(`pg_dump did not finish in ${DUMP_TIMEOUT_MS / 60000} minutes and was stopped`);
    if (dump.code !== 0) {
      throw new Problem(`pg_dump failed (exit code ${dump.code}):\n${dump.stderr.trim() || "no message"}`);
    }

    // Read the file back: its table of contents must be there and name the table the money lives in.
    const listing = await run(pgRestore, ["--list", partial], { env: toolEnvironment(connection) });
    if (listing.code !== 0) {
      throw new Problem(`The copy cannot be read back (pg_restore exit code ${listing.code}):\n${listing.stderr.trim()}`);
    }
    if (!/\bTABLE DATA public operations\b/.test(listing.stdout)) {
      throw new Problem(
        `The copy does not hold the operations table: is DATABASE_URL pointing at the right database ("${connection.database}")?`,
      );
    }

    await patiently(() => rename(partial, finalPath));
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    if (error instanceof Problem) throw error;
    if (error.code === "ENOENT") {
      throw new Problem(`Could not start ${error.path ?? "a PostgreSQL tool"}: ${error.message}`);
    }
    throw error;
  }
  await chmod(finalPath, 0o600).catch(() => {});

  const size = (await stat(finalPath)).size;
  console.log(`Copy made: ${finalPath} (${megabytes(size)})`);

  await tidy(folder, connection.database, keep, name);
  return { path: finalPath, size };
}

/**
 * Deletes the copies beyond the newest `keep`, and what a copy that was cut off long ago left behind.
 * The copy just made is never deleted, even if the clock of the machine was set back and the names of
 * the older copies look newer than it.
 */
async function tidy(folder, database, keep, justMade) {
  const stale = (await listCopies(folder, database)).slice(keep).filter((copy) => copy.name !== justMade);
  const removed = [];
  for (const copy of stale) {
    try {
      await patiently(() => rm(copy.path));
      removed.push(copy.name);
    } catch (error) {
      console.error(`Warning: could not delete the old copy ${copy.path}: ${error.message}`);
    }
  }
  if (removed.length > 0) console.log(`Deleted ${removed.length} old ${removed.length === 1 ? "copy" : "copies"} (the newest ${keep} are kept).`);

  // A copy that was cut off (power loss, the task killed) leaves its unfinished file. Not one that may be running now.
  const partials = copyPattern(database, { partial: true });
  for (const name of (await readdir(folder)).filter((item) => partials.test(item))) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > DAY_MS) {
      await rm(path, { force: true }).catch(() => {});
      console.log(`Deleted an unfinished copy from an earlier run: ${name}`);
    }
  }
}

async function status(folder, database, maxAgeHours) {
  const copies = await listCopies(folder, database);
  if (copies.length === 0) {
    throw new Problem(`There is no copy of "${database}" in ${folder}. The nightly copy has never worked, or it writes somewhere else.`);
  }
  const newest = copies[0];
  const ageHours = (Date.now() - newest.modifiedMs) / 3_600_000;
  console.log(
    `Newest copy: ${newest.name} (${megabytes(newest.size)}), made ${
      ageHours < 1 ? "less than an hour" : `${Math.floor(ageHours)} hours`
    } ago. ${copies.length} ${copies.length === 1 ? "copy" : "copies"} in ${folder}.`,
  );
  if (ageHours > maxAgeHours) {
    throw new Problem(`The newest copy is older than ${maxAgeHours} hours: the nightly copy has stopped working.`);
  }
}
