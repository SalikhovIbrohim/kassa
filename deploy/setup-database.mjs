#!/usr/bin/env node
// Prepares PostgreSQL for the Kassa server on a new machine: a role and a database of their own,
// and the settings file that holds their password. Safe to run again: what exists is kept.
//
//   node deploy/setup-database.mjs --settings C:\kassa\config\kassa.env
//
// It connects as the PostgreSQL administrator. Connection details come from the usual variables:
// PGPASSWORD (required), PGUSER (default "postgres"), PGHOST (default 127.0.0.1), PGPORT (default 5432).
// The new password is never printed.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

const USAGE = `Usage: node deploy/setup-database.mjs --settings <path> [--role kassa] [--database kassa]

Creates the role and the database if they are missing, and writes the settings file if it is missing.
Set PGPASSWORD to the password of the PostgreSQL administrator (the "postgres" user).`;

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const templatePath = fileURLToPath(new URL("./kassa.env.example", import.meta.url));

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    settings: { type: "string" },
    role: { type: "string", default: "kassa" },
    database: { type: "string", default: "kassa" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.settings) fail(`--settings is required\n\n${USAGE}`);
for (const [flag, name] of [["--role", values.role], ["--database", values.database]]) {
  if (!NAME.test(name)) fail(`${flag} must be lower-case letters, digits and underscores, got "${name}"`);
}
if (!process.env.PGPASSWORD) fail("set PGPASSWORD to the password of the PostgreSQL administrator");

const envFile = resolve(values.settings);
const admin = new pg.Client({
  host: process.env.PGHOST ?? "127.0.0.1",
  user: process.env.PGUSER ?? "postgres",
  database: "postgres",
});
try {
  await admin.connect();
} catch (error) {
  fail(`could not connect to PostgreSQL as ${process.env.PGUSER ?? "postgres"}: ${error.message}`);
}

// The password is in the text of the statements that make the role. Keep them out of PostgreSQL's own log,
// which would get the whole statement if one failed, or every one with log_statement set to ddl or all, or
// with log_min_duration_statement set to 0 (some people turn that on to see what is slow).
for (const statement of ["SET log_min_error_statement = 'panic'", "SET log_statement = 'none'", "SET log_min_duration_statement = -1"]) {
  await admin.query(statement).catch(() => {});
}

try {
  // The password already in the settings file wins: running this again must not lock the server out.
  let password;
  if (existsSync(envFile)) {
    password = passwordFrom(await readFile(envFile, "utf8"), values.role, values.database);
  }
  const keep = password !== undefined;
  password ??= randomBytes(24).toString("base64url");

  const role = admin.escapeIdentifier(values.role);
  const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [values.role])).rowCount > 0;
  if (!roleExists) {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(password)}`);
    console.log(`Created the role "${values.role}".`);
  } else if (!keep) {
    // A run that stopped before the file was written left the role behind: it gets the new password.
    await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(password)}`);
    console.log(`The role "${values.role}" exists already: its password is now the one in the new settings file.`);
  } else {
    console.log(`The role "${values.role}" exists already.`);
  }

  const existing = await admin.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1", [values.database]);
  if (existing.rowCount === 0) {
    // UTF8 whatever the locale of the machine: PostgreSQL on Windows would otherwise use the Windows
    // code page of the system (WIN1251, WIN1252...), which cannot keep most of what people type.
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(values.database)} OWNER ${role} ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`Created the database "${values.database}".`);
  } else if (existing.rows[0].encoding !== "UTF8") {
    fail(
      `The database "${values.database}" exists, but stores text as ${existing.rows[0].encoding}, and Kassa needs UTF8. ` +
        "If it holds nothing you need, drop it and run this again.",
    );
  } else {
    console.log(`The database "${values.database}" exists already.`);
  }

  await warnIfOpenToOthers();

  if (keep) {
    console.log(`Kept the settings file ${envFile}.`);
  } else {
    const template = await readFile(templatePath, "utf8");
    const url = `postgres://${encodeURIComponent(values.role)}:${encodeURIComponent(password)}@127.0.0.1:${process.env.PGPORT ?? 5432}/${encodeURIComponent(values.database)}`;
    const text = template.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`);
    await mkdir(dirname(envFile), { recursive: true });
    // Without a byte order mark, with the plain line ends the reader expects.
    await writeFile(envFile, text, { encoding: "utf8", mode: 0o600 });
    await chmod(envFile, 0o600).catch(() => {});
    console.log(`Wrote the settings file ${envFile}. Only administrators should be able to read it.`);
  }
} catch (error) {
  fail(error.message);
} finally {
  await admin.end().catch(() => {});
}

/**
 * Only the application on this machine needs PostgreSQL. A pg_hba.conf that lets other addresses log in
 * (the installer of some versions, or somebody following a guide, adds such a line) is worth a warning.
 * The view is readable by the administrator only; if it cannot be read there is nothing to say.
 */
async function warnIfOpenToOthers() {
  let rules;
  try {
    rules = await admin.query(`
      SELECT line_number, type, database::text AS database, user_name::text AS users, address, netmask, auth_method
        FROM pg_hba_file_rules
       WHERE error IS NULL AND type LIKE 'host%'
         AND (address IS NULL OR address NOT IN ('127.0.0.1', '::1', 'localhost'))
       ORDER BY line_number`);
  } catch {
    return;
  }
  if (rules.rowCount === 0) return;
  const lines = rules.rows.map((row) => `  line ${row.line_number}: ${row.type} ${row.database} ${row.users} ${row.address ?? ""}${row.netmask ? `/${row.netmask}` : ""} ${row.auth_method}`);
  console.log(
    "Warning: pg_hba.conf lets other computers than this one log in to PostgreSQL:\n" +
      `${lines.join("\n")}\n` +
      "Only Kassa on this machine needs it. Keep the lines for 127.0.0.1 and ::1 and remove the others " +
      "(docs/deploy-windows.md, the section on the database), then restart the PostgreSQL service.",
  );
}

/** The password of the database role named in an existing settings file, if it is there. */
function passwordFrom(text, role, database) {
  const line = /^DATABASE_URL=(.*)$/m.exec(text)?.[1]?.trim();
  if (!line) return undefined;
  try {
    const url = new URL(line);
    if (decodeURIComponent(url.username) !== role || decodeURIComponent(url.pathname.slice(1)) !== database) {
      fail(`${envFile} names another role or database than --role and --database; fix one or the other`);
    }
    const password = decodeURIComponent(url.password);
    return password && password !== "CHANGE-ME" ? password : undefined;
  } catch {
    return undefined;
  }
}
