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
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LABEL,
  Problem,
  backupFolder,
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
  node deploy/backup.mjs --settings <settings file> [--to <folder>] [--keep <number>] [--label <word>] [--pg-bin <folder>] [--log <file>]
  node deploy/backup.mjs --settings <settings file> --status [--to <folder>] [--max-age-hours <hours>]
  node deploy/backup.mjs --settings <settings file> --where [--to <folder>] [--default-folder <folder>]

Makes a compressed copy of the database named by DATABASE_URL in the settings file, and puts it in the
folder given by --to, or by BACKUP_DIR in the settings file (a full path; if it has a # in it, in single
quotes), or by --default-folder. The newest 14 copies are kept (--keep, or BACKUP_KEEP); older copies of
the same database are deleted, but only after the new copy is made and checked. Nothing else in the
folder is touched.
--label makes a copy for a purpose, named kassa-<time>-<label>.dump (update.ps1 uses before-update). Those
are kept apart from the nightly ones, the newest 5 of each label, so that neither pushes out the other.
pg_dump is found on the PATH, or in the folder given by --pg-bin (or PG_BIN in the settings file).
--log adds a line to that file for every run, with the time: OK and the file made, or FAILED and why.
--where only prints the folder the copies go to.

Exit code 0: the copy was made. 1: it was not (the reason is printed). 2: wrong use.
With --status nothing is copied: the exit code is 0 if the newest nightly copy is not older than
--max-age-hours (default 26), and 1 if there is none or it is older.`;

const DEFAULT_KEEP = 14;
// How many copies of each label (not the nightly ones) are kept.
const KEEP_LABELED = 5;
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
      "default-folder": { type: "string" },
      keep: { type: "string" },
      label: { type: "string" },
      "pg-bin": { type: "string" },
      log: { type: "string" },
      status: { type: "boolean" },
      where: { type: "boolean" },
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
if (options.label !== undefined && !LABEL.test(options.label)) usageError(`--label must be lower-case words joined by hyphens (before-update), got "${options.label}"`);

/** A whole number from the command line: a mistake there is a wrong use. From the settings file it is a problem of the machine. */
function wholeNumber(text, what, minimum, { fromSettings = false } = {}) {
  const number = Number(text);
  if (!/^\d+$/.test(String(text).trim()) || number < minimum) {
    const message = `${what} must be a whole number, ${minimum} or more, got "${text}"`;
    if (fromSettings) throw new Problem(message);
    usageError(message);
  }
  return number;
}

try {
  const settingsPath = resolve(options.settings);
  const settings = await readSettings(settingsPath);
  const connection = connectionFrom(settings, settingsPath);
  const folder = backupFolder({ to: options.to, settings, defaultFolder: options["default-folder"] });

  if (options.where) {
    console.log(folder);
  } else if (options.status) {
    const maxAge = wholeNumber(options["max-age-hours"] ?? DEFAULT_MAX_AGE_HOURS, "--max-age-hours", 1);
    await status(folder, connection.database, maxAge);
  } else {
    const keep = options.label
      ? KEEP_LABELED
      : options.keep === undefined
        ? wholeNumber(settings.BACKUP_KEEP ?? DEFAULT_KEEP, "BACKUP_KEEP in the settings file", 1, { fromSettings: true })
        : wholeNumber(options.keep, "--keep", 1);
    const made = await backup({ folder, connection, keep, label: options.label, pgBin: options["pg-bin"] ?? settings.PG_BIN });
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

async function backup({ folder, connection, keep, label, pgBin }) {
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
    name = `${connection.database}-${stamp()}${label ? `-${label}` : ""}.dump`;
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

  await tidy(folder, connection.database, keep, name, label);
  return { path: finalPath, size };
}

/**
 * Deletes the copies of this kind (nightly, or of this label) beyond the newest `keep`, and what a copy that
 * was cut off long ago left behind. The copy just made is never deleted. A copy dated in the future (the
 * clock was wrong when it was made) is not counted and not deleted: it is named, so that somebody looks.
 */
async function tidy(folder, database, keep, justMade, label) {
  const { copies, future } = await listCopies(folder, database, { label });
  const stale = copies.slice(keep).filter((copy) => copy.name !== justMade);
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
  for (const copy of future) {
    console.log(`Warning: ${copy.name} is dated in the future: the clock of this computer was wrong when it was made. It is not counted and not deleted; delete it when you have looked at it.`);
  }

  // A copy that was cut off (power loss, the task killed) leaves its unfinished file. Not one that may be running now.
  const partials = copyPattern(database, { partial: true, anyLabel: true });
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
  // Only the copies without a label: one made before an update says nothing about the nightly task.
  const { copies, future } = await listCopies(folder, database);
  for (const copy of future) {
    console.log(`Warning: ${copy.name} is dated in the future (the clock was wrong when it was made) and is not counted.`);
  }
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
