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
