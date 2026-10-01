#!/usr/bin/env node
// Puts a copy made by deploy/backup.mjs back into PostgreSQL.
//
//   node deploy/restore.mjs --settings C:\kassa\config\kassa.env --from D:\kassa-copies\kassa-20261001-030000.dump --check
//   node deploy/restore.mjs --settings C:\kassa\config\kassa.env --from D:\kassa-copies\kassa-20261001-030000.dump --replace
//
// It never writes into the live database. The copy is restored into a new database first; only if that
// worked completely is it swapped in (by renaming), and the database that was live is kept under another name.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { Problem, connectionFrom, findTool, readSettings, run, sleep, stamp, toolEnvironment } from "./backup-lib.mjs";

const USAGE = `Usage:
  node deploy/restore.mjs --settings <settings file> --from <copy> --check [--pg-bin <folder>]
  node deploy/restore.mjs --settings <settings file> --from <copy> --replace [--pg-bin <folder>]

--check     Restores the copy into a scratch database, shows what is in it, and deletes the scratch
            database again. Nothing that is in use is touched. Do this now and then: a copy that was
            never tried is only a hope.
--replace   Puts the copy in place of the live database (the one named by DATABASE_URL in the settings
            file). Stop the Kassa service first. The database that was live is NOT deleted: it is renamed
            (kassa_before_restore_<date>), so that the step can be undone. If anything fails, the live
            database stays as it was.

Needs the password of the PostgreSQL administrator in the variable PGPASSWORD (the user is PGUSER,
"postgres" if not set): creating a database is not something the Kassa role may do.

Exit code 0: done. 1: not done (the reason is printed). 2: wrong use.`;

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
      from: { type: "string" },
      check: { type: "boolean" },
      replace: { type: "boolean" },
      "pg-bin": { type: "string" },
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
if (!options.from) usageError("--from <copy> is required");
if (Boolean(options.check) === Boolean(options.replace)) usageError("Give exactly one of --check and --replace");

const migrationsDir = fileURLToPath(new URL("../server/migrations/", import.meta.url));

/** Databases this run made, to remove if the run does not end with them in use. */
const scratch = new Set();
let admin;

try {
  await main();
} catch (error) {
  if (error instanceof Problem) {
    console.error(`Error: ${error.message}`);
  } else if (error?.code === "ENOENT") {
    console.error(`Error: could not start ${error.path ?? "a PostgreSQL tool"}: ${error.message}`);
  } else {
    console.error(`Error: ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
} finally {
  await cleanUp();
}

async function main() {
  const settingsPath = resolve(options.settings);
  const settings = await readSettings(settingsPath);
  const connection = connectionFrom(settings, settingsPath);
  const pgBin = options["pg-bin"] ?? settings.PG_BIN;
  const copy = resolve(options.from);
  if (!existsSync(copy)) throw new Problem(`There is no file ${copy}`);
  if (!process.env.PGPASSWORD) {
    throw new Problem("Set PGPASSWORD to the password of the PostgreSQL administrator (the \"postgres\" user).");
  }

  const pgRestore = await findTool("pg_restore", pgBin);
  await readable(pgRestore, copy, connection);

  const adminUser = process.env.PGUSER ?? "postgres";
  admin = new pg.Client({ host: connection.host, port: Number(connection.port), user: adminUser, password: process.env.PGPASSWORD, database: "postgres" });
  try {
    await admin.connect();
  } catch (error) {
    admin = undefined;
    throw new Problem(`Could not connect to PostgreSQL as ${adminUser}: ${error.message}`);
  }
  const roles = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [connection.user]);
  if (roles.rowCount === 0) {
    throw new Problem(`The PostgreSQL role "${connection.user}" does not exist. Run deploy/setup-database.mjs first.`);
  }

  const live = connection.database;
  if (options.replace) await assertNobodyUses(live);

  const trial = await restoreIntoNewDatabase(pgRestore, copy, connection, options.replace ? "restoring" : "check");
  const found = await look(trial, connection);
  console.log(describe(found));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));
  const newer = found.migrations.filter((name) => !files.includes(name));
  const older = files.filter((name) => !found.migrations.includes(name));
  if (newer.length > 0) {
    const message = `This copy was made by a newer version of Kassa (${newer.join(", ")}) than the one installed here: install the newer version first.`;
    if (options.replace) throw new Problem(message);
    console.log(`Warning: ${message}`);
  }
  if (older.length > 0) {
    console.log(`The copy is from an older version of Kassa. The server brings it up to date when it starts (${older.join(", ")}).`);
  }

  if (options.check) {
    await dropDatabase(trial);
    console.log("The copy can be restored. The scratch database is deleted again; nothing in use was touched.");
    return;
  }

  const kept = await swapIn(trial, live);
  console.log(`Restored: the database "${live}" now holds the copy.`);
  if (kept) {
    console.log(`The database that was live is kept as "${kept}". Delete it when you are sure the restored data is right.`);
  }
}

/** The copy must be a readable file made by backup.mjs, before anything is created. */
async function readable(pgRestore, copy, connection) {
  const listing = await run(pgRestore, ["--list", copy], { env: toolEnvironment(connection) });
  if (listing.code !== 0) {
    throw new Problem(`${copy} is not a copy that can be restored (pg_restore says: ${listing.stderr.trim() || `exit code ${listing.code}`}).`);
  }
  if (!/\bTABLE DATA public operations\b/.test(listing.stdout)) {
    throw new Problem(`${copy} holds no operations table: it is not a copy of the Kassa database.`);
  }
}

async function assertNobodyUses(database) {
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
  if (rows[0].n > 0) {
    throw new Problem(
      `"${database}" is in use (${rows[0].n} connection${rows[0].n === 1 ? "" : "s"}). Stop the Kassa service (KassaApp) first, and close pgAdmin if it is open.`,
    );
  }
}

/** Makes a new database owned by the Kassa role and restores the copy into it, all or nothing. */
async function restoreIntoNewDatabase(pgRestore, copy, connection, purpose) {
  const name = `${shorten(connection.database, 40)}_${purpose}_${randomBytes(3).toString("hex")}`;
  const role = admin.escapeIdentifier(connection.user);
  scratch.add(name);
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} OWNER ${role} ENCODING 'UTF8' TEMPLATE template0`);

  const result = await run(
    pgRestore,
    ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", name, copy],
    { env: toolEnvironment(connection) },
  );
  if (result.code !== 0) {
    throw new Problem(`The copy could not be restored (pg_restore exit code ${result.code}):\n${result.stderr.trim() || "no message"}`);
  }
  return name;
}

/** What is in the restored database, read as the Kassa role, the way the server will read it. */
async function look(database, connection) {
  const client = new pg.Client({ host: connection.host, port: Number(connection.port), user: connection.user, password: connection.password, database });
  try {
    await client.connect();
  } catch (error) {
    throw new Problem(`Could not connect to the restored database as "${connection.user}": ${error.message}. Is the password in the settings file the role's?`);
  }
  /** What every copy of Kassa has: when it is not there, this is not a copy of Kassa. */
  const must = async (sql) => (await client.query(sql)).rows[0];
  /**
   * What a later version added (deleting, the history of changes): a copy made by an older version has not got it, and
   * putting such a copy back is exactly what going back to an older version needs, so it is not an error.
   */
  const maybe = async (sql) => {
    try {
      return (await client.query(sql)).rows[0].n;
    } catch {
      return null;
    }
  };
  try {
    const users = (await must("SELECT count(*)::int AS n FROM users")).n;
    const operations = (await must("SELECT count(*)::int AS n FROM operations")).n;
    const newest = (await must("SELECT to_char(max(created_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS newest FROM operations")).newest;
    const migrations = (await client.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name);
    const deleted = await maybe("SELECT count(*)::int AS n FROM operations WHERE deleted_at IS NOT NULL");
    const changes = await maybe("SELECT count(*)::int AS n FROM operation_changes");
    return { users, operations, deleted, changes, newest, migrations };
  } catch (error) {
    throw new Problem(`The restored database does not look like Kassa's (${error.message}).`);
  } finally {
    await client.end().catch(() => {});
  }
}

function describe(found) {
  const newest = found.newest ? `the newest is from ${found.newest} (Moscow time)` : "there are none yet";
  const history = found.changes === null ? "no history of changes yet (a copy of an older version)" : `${found.changes} line${found.changes === 1 ? "" : "s"} of history`;
  return (
    `The copy holds ${found.users} user${found.users === 1 ? "" : "s"}, ${found.operations} operation${found.operations === 1 ? "" : "s"}` +
    `${found.deleted > 0 ? ` (${found.deleted} of them deleted)` : ""}, ${history}; ${newest}. ` +
    `Last migration: ${found.migrations.at(-1) ?? "none"}.`
  );
}

/**
 * The first characters of a name that take at most `limit` bytes. PostgreSQL cuts a name at 63 bytes, and a name
 * that was cut is not the one that was printed (letters outside ASCII take two bytes or more).
 */
function shorten(text, limit) {
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    bytes += size;
    result += char;
  }
  return result;
}

/**
 * Renames the live database out of the way and the restored one into its place, both in one transaction: the
 * computer going down between the two would otherwise leave no database of the live name at all. Returns the
 * new name of the old one.
 */
async function swapIn(restored, live) {
  const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [live])).rowCount > 0;
  const kept = exists ? `${shorten(live, 30)}_before_restore_${stamp().replace("-", "_")}` : undefined;
  let renaming = "the live database";
  try {
    await admin.query("BEGIN");
    if (kept) await admin.query(`ALTER DATABASE ${admin.escapeIdentifier(live)} RENAME TO ${admin.escapeIdentifier(kept)}`);
    renaming = "the restored database";
    await admin.query(`ALTER DATABASE ${admin.escapeIdentifier(restored)} RENAME TO ${admin.escapeIdentifier(live)}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => {});
    throw new Problem(
      renaming === "the live database"
        ? `The live database could not be renamed, so nothing was changed: ${error.message}`
        : `The restored database could not be put in place, so nothing was changed: ${error.message}`,
    );
  }
  scratch.delete(restored);
  return kept;
}

/** Drops a database this run made. Waits for the last connections to close. */
async function dropDatabase(name) {
  const quoted = admin.escapeIdentifier(name);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted}`);
      scratch.delete(name);
      return;
    } catch {
      await sleep(200);
    }
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  scratch.delete(name);
}

async function cleanUp() {
  if (!admin) return;
  for (const name of [...scratch]) {
    await dropDatabase(name).catch((error) => console.error(`Warning: could not delete the scratch database "${name}": ${error.message}`));
  }
  await admin.end().catch(() => {});
}
