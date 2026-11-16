import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { KEYS, startFakeOneC, type FakeOneC } from "./helpers/fake-onec.js";
import { createBlankDatabase } from "./helpers/test-app.js";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

/** Runs the admin command line the way an update script does: its own process, its own environment. */
function runCli(args: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/admin/cli.ts", ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: undefined, KASSA_PASSWORD: undefined, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("admin command line: migrate", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function blankDatabase() {
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    return database.url;
  }

  it("builds a blank database, says what it applied, and finds nothing to do the second time", async () => {
    const url = await blankDatabase();

    const first = await runCli(["migrate"], { DATABASE_URL: url });
    const second = await runCli(["migrate"], { DATABASE_URL: url });

    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Applied migrations: 0001_users_and_sessions\.sql, .*0004_corrections\.sql/);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe("The database is up to date.");
    // The database is usable afterwards.
    const balances = await runCli(["balances"], { DATABASE_URL: url });
    expect(balances.code).toBe(0);
    expect(balances.stdout).toContain("RUB");
  }, 30_000);

  it("fails with a nonzero exit code when the database cannot be reached, so a script can stop", async () => {
    const result = await runCli(["migrate"], { DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("up to date");
    expect(result.stderr).not.toBe("");
  }, 30_000);

  it("refuses a database that does not store text as UTF8, and says how to make one that does", async () => {
    const database = await createBlankDatabase({ encoding: "LATIN1" });
    cleanups.push(database.drop);

    const result = await runCli(["migrate"], { DATABASE_URL: database.url });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('stores text as LATIN1');
    expect(result.stderr).toContain("ENCODING 'UTF8' TEMPLATE template0");
    expect(result.stderr).not.toContain("    at "); // a message, not a stack trace
    // Nothing was created in it.
    const probe = new pg.Client({ connectionString: database.url });
    await probe.connect();
    const tables = await probe.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    await probe.end();
    expect(tables.rows[0].n).toBe(0);
  }, 30_000);

  it("refuses a database that a newer version has changed, and goes on only when told to", async () => {
    const url = await blankDatabase();
    await runCli(["migrate"], { DATABASE_URL: url });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("INSERT INTO schema_migrations (name) VALUES ('9999_from_a_newer_version.sql')");
    await client.end();

    const refused = await runCli(["balances"], { DATABASE_URL: url });
    const forced = await runCli(["balances"], { DATABASE_URL: url, ALLOW_NEWER_SCHEMA: "1" });

    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("9999_from_a_newer_version.sql");
    expect(refused.stderr).toContain("can show wrong balances");
    expect(refused.stdout).not.toContain("RUB");
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("RUB");
  }, 30_000);

  it("says what is missing when there is no DATABASE_URL", async () => {
    const result = await runCli(["migrate"], {});

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required");
  }, 30_000);

  /** Runs SQL in a database of a test, as something that was left there before the migration (a table of that name). */
  async function inDatabase(url: string, sql: string) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  it("exits with 4 when the first migration fails: nothing was applied, the database is as it was, so the old version can run", async () => {
    const url = await blankDatabase();
    await inDatabase(url, "CREATE TABLE users (leftover int)");

    const result = await runCli(["migrate"], { DATABASE_URL: url });

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("0001_users_and_sessions.sql failed");
    expect(result.stderr).toContain("Nothing was applied: the database is as it was");
    expect(result.stderr).not.toContain("    at "); // a message, not a stack trace
    const probe = new pg.Client({ connectionString: url });
    await probe.connect();
    const recorded = await probe.query("SELECT count(*)::int AS n FROM schema_migrations");
    await probe.end();
    expect(recorded.rows[0].n).toBe(0);
  }, 30_000);

  it("exits with 1, and names what was applied, when a later migration fails: the database has been changed", async () => {
    const url = await blankDatabase();
    await inDatabase(url, "CREATE TABLE operations (leftover int)");

    const result = await runCli(["migrate"], { DATABASE_URL: url });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("0002_operations.sql failed");
    expect(result.stderr).toContain("Applied before it: 0001_users_and_sessions.sql");
  }, 30_000);
});

describe("admin command line: onec-check", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let onec: FakeOneC;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function world() {
    onec = await startFakeOneC();
    cleanups.push(() => onec.close());
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    return database.url;
  }

  it("reads the settings of 1C under their own names, and looks even while the writing is off", async () => {
    const url = await world();

    const result = await runCli(["onec-check"], {
      DATABASE_URL: url,
      ONEC_ODATA_URL: onec.url,
      ONEC_ODATA_USER: onec.user,
      ONEC_ODATA_PASSWORD: onec.password,
      ONEC_ORGANIZATION_KEY: KEYS.organization,
      ONEC_KASSA_KEY: KEYS.kassa,
      ONEC_CURRENCY_KEY: KEYS.currency,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("репетиция");
    expect(result.stdout).toContain("Всё готово.");
    expect(onec.requests.every((line) => line.startsWith("GET"))).toBe(true);
  }, 30_000);

  it("goes on reading a settings file that names them the earlier way, with its mode", async () => {
    const url = await world();

    const result = await runCli(["onec-check"], {
      DATABASE_URL: url,
      COSMO_1C_MODE: "live",
      COSMO_ODATA_URL: onec.url,
      COSMO_ODATA_USER: onec.user,
      COSMO_ODATA_PASSWORD: onec.password,
      COSMO_1C_ORGANIZATION_KEY: KEYS.organization,
      COSMO_1C_KASSA_KEY: KEYS.kassa,
      COSMO_1C_CURRENCY_KEY: KEYS.currency,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("БОЕВОЙ");
    expect(result.stdout).toContain("Всё готово.");
  }, 30_000);

  it("says which setting is missing, by the name the settings file uses", async () => {
    const url = await world();

    const own = await runCli(["onec-check"], { DATABASE_URL: url, ONEC_ODATA_URL: onec.url });
    const earlier = await runCli(["onec-check"], { DATABASE_URL: url, COSMO_1C_MODE: "preview", COSMO_ODATA_URL: onec.url });

    expect(own.code).toBe(1);
    expect(own.stderr).toContain("ONEC_ODATA_USER is required when ONEC_MODE is preview");
    expect(earlier.code).toBe(1);
    expect(earlier.stderr).toContain("COSMO_ODATA_USER is required when COSMO_1C_MODE is preview");
  }, 30_000);
});
