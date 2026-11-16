#!/usr/bin/env node
// Prepares PostgreSQL for the Kassa server on a new machine: a role and a database of their own,
// and the settings file that holds their password. Safe to run again: what exists is kept.
//
//   node deploy/setup-database.mjs --settings C:\kassa\config\kassa.env
//   node deploy/setup-database.mjs --settings C:\kassa-express\config\kassa.env --instance express --port 3001
//
// The second line is for another installation on the same machine (the cash desk of another company): a role, a
// database, a port and a name of its own, so that it shares nothing with the first.
//
// It connects as the PostgreSQL administrator. Connection details come from the usual variables:
// PGPASSWORD (required), PGUSER (default "postgres"), PGHOST (default 127.0.0.1), PGPORT (default 5432).
// The new password is never printed.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import pg from "pg";

const USAGE = `Usage: node deploy/setup-database.mjs --settings <path> [--instance <name> --port <port>] [--role <role>] [--database <database>]

Creates the role and the database if they are missing, and writes the settings file if it is missing.
The role and the database are both "kassa" unless named.
--instance is for another installation on the same machine (the cash desk of another company). Its role and its
database are then kassa_<name> unless named, and its settings file gets the lines INSTANCE=<name>, by which the
scripts of deploy/windows name its service and its tasks, and PORT=<port>: every installation listens on a port
of its own.
Set PGPASSWORD to the password of the PostgreSQL administrator (the "postgres" user).`;

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
// What goes into the name of a role here and into the names of a service and of a task in deploy/windows/common.ps1.
const INSTANCE = /^[a-z][a-z0-9]{0,15}$/;
const templatePath = fileURLToPath(new URL("./kassa.env.example", import.meta.url));

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    settings: { type: "string" },
    instance: { type: "string" },
    port: { type: "string" },
    role: { type: "string" },
    database: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.settings) fail(`--settings is required\n\n${USAGE}`);
if (values.instance !== undefined && !INSTANCE.test(values.instance)) {
  fail(`--instance must be one short lower-case word of letters and digits (express), got "${values.instance}"`);
}
if (values.port !== undefined && (!/^\d{1,5}$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)) {
  fail(`--port must be a port number, like 3001, got "${values.port}"`);
}
if (values.instance && values.port === undefined) {
  fail("--instance needs --port: every installation on the machine listens on a port of its own (the first one on 3000, so 3001, say)");
}
const ownNames = values.instance ? `kassa_${values.instance}` : "kassa";
values.role ??= ownNames;
values.database ??= ownNames;
for (const [flag, name] of [["--role", values.role], ["--database", values.database]]) {
  if (!NAME.test(name)) fail(`${flag} must be lower-case letters, digits and underscores, got "${name}"`);
}
if (!process.env.PGPASSWORD) fail("set PGPASSWORD to the password of the PostgreSQL administrator");

const envFile = resolve(values.settings);
const template = await readFile(templatePath, "utf8");
// Found out now, before anything is created: the lines this script fills in must be in the template.
if (values.port !== undefined && !/^PORT=.*$/m.test(template)) fail(`${templatePath} has no PORT= line to write the port into`);
if (values.instance && !/^# INSTANCE=.*$/m.test(template)) fail(`${templatePath} has no "# INSTANCE=" line to write the name into`);
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
    const text = await readFile(envFile, "utf8");
    password = passwordFrom(text, values.role, values.database);
    // A settings file of one installation is never taken for another's: the scripts name its service by this line.
    const written = parseEnv(text);
    const whose = (name) => (name ? `the installation "${name}"` : "the first installation (it has no INSTANCE line)");
    if ((written.INSTANCE ?? "").trim() !== (values.instance ?? "")) {
      fail(`${envFile} is the settings file of ${whose((written.INSTANCE ?? "").trim())}, not of ${whose(values.instance ?? "")}: give the folder and the --instance that belong together`);
    }
    if (values.port !== undefined && (written.PORT ?? "3000").trim() !== values.port) {
      console.log(`Note: ${envFile} is kept as it is, with PORT=${(written.PORT ?? "3000").trim()}: --port ${values.port} was not written. Change the line there if it is to change.`);
    }
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
    const url = `postgres://${encodeURIComponent(values.role)}:${encodeURIComponent(password)}@127.0.0.1:${process.env.PGPORT ?? 5432}/${encodeURIComponent(values.database)}`;
    let text = template.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`);
    if (values.port !== undefined) text = text.replace(/^PORT=.*$/m, `PORT=${values.port}`);
    if (values.instance) text = text.replace(/^# INSTANCE=.*$/m, `INSTANCE=${values.instance}`);
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
