import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string };

/** Runs one of the scripts in deploy/ the way a person or an update script would: its own process. */
function runScript(script: string, args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "deploy", script), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("deploy/check.mjs: the check after an install or an update", () => {
  let webDistDir: string;
  let app: TestApp | undefined;

  beforeAll(async () => {
    // A stand-in for the folder that `vite build` produces.
    webDistDir = await mkdtemp(join(tmpdir(), "kassa-check-"));
    await writeFile(join(webDistDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
    await writeFile(join(webDistDir, "manifest.webmanifest"), '{"name":"Касса"}');
  });

  afterAll(async () => {
    await rm(webDistDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("passes on a server that is up, serves the web app and asks for a login", async () => {
    app = await startTestApp({ webDistDir });

    const result = await runScript("check.mjs", [app.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok    health");
    expect(result.stdout).toContain("ok    app shell");
    expect(result.stdout).toContain("ok    manifest");
    expect(result.stdout).toContain("ok    login required");
    expect(result.stdout).toContain("All checks passed.");
  }, 30_000);

  it("names what is wrong and exits with 1 when the database is down and the web app is not served", async () => {
    app = await startTestApp({ databaseUrl: "postgres://nobody:nothing@127.0.0.1:1/none" });

    const result = await runScript("check.mjs", [app.baseUrl]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL {2}health: .*database down/);
    expect(result.stdout).toMatch(/FAIL {2}app shell: /);
    expect(result.stdout).toMatch(/FAIL {2}manifest: /);
    expect(result.stdout).toContain("checks failed.");
  }, 30_000);

  it("does not take any page for the web app: something else may be answering on that address", async () => {
    const strangerDir = await mkdtemp(join(tmpdir(), "kassa-stranger-"));
    try {
      await writeFile(join(strangerDir, "index.html"), "<!doctype html><html><body>Welcome to nginx!</body></html>");
      app = await startTestApp({ webDistDir: strangerDir });

      const result = await runScript("check.mjs", [app.baseUrl]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("FAIL  app shell");
      expect(result.stdout).toContain("the web app is not being served");
    } finally {
      await rm(strangerDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("says that nothing is listening when the service is not running", async () => {
    app = await startTestApp({ webDistDir });
    const address = app.baseUrl;
    await app.close();
    app = undefined;

    const result = await runScript("check.mjs", [address]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("nothing is listening at that address and port");
  }, 30_000);

  it("signs in once with the login it is given, and signs out again", async () => {
    app = await startTestApp({ webDistDir });
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    const result = await runScript("check.mjs", [app.baseUrl, "--login", "ivan"], { KASSA_CHECK_PASSWORD: "correct horse" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok    sign in: ivan can sign in");
    // It leaves no session behind.
    expect(await app.query("SELECT 1 FROM sessions")).toEqual([]);
  }, 30_000);

  it("fails the sign-in check on a wrong password, and when no password is given", async () => {
    app = await startTestApp({ webDistDir });
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    const wrong = await runScript("check.mjs", [app.baseUrl, "--login", "ivan"], { KASSA_CHECK_PASSWORD: "not it at all" });
    const none = await runScript("check.mjs", [app.baseUrl, "--login", "ivan"], { KASSA_CHECK_PASSWORD: undefined });

    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toContain("FAIL  sign in: status 401");
    expect(none.code).toBe(1);
    expect(none.stdout).toContain("set KASSA_CHECK_PASSWORD");
  }, 30_000);

  it("shows how to use it, and exits with 2, when the address is missing or is not one", async () => {
    const missing = await runScript("check.mjs", []);
    const nonsense = await runScript("check.mjs", ["not an address"]);
    const wrongScheme = await runScript("check.mjs", ["ftp://example.com"]);

    for (const result of [missing, nonsense, wrongScheme]) {
      expect(result.code).toBe(2);
    }
    expect(missing.stdout).toContain("Usage: node deploy/check.mjs");
    expect(nonsense.stderr).toContain("is not an address");
    expect(wrongScheme.stderr).toContain("must start with http:// or https://");
  }, 30_000);
});

describe("deploy/setup-database.mjs: a role, a database and the settings file on a new machine", () => {
  const admin = new URL(process.env.TEST_DATABASE_URL ?? "postgres://kassa_test:kassa_test@localhost:5432/postgres");
  const adminEnv = {
    PGHOST: admin.hostname,
    PGPORT: admin.port || "5432",
    PGUSER: decodeURIComponent(admin.username),
    PGPASSWORD: decodeURIComponent(admin.password),
  };
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Names of our own and a folder for the settings file; everything is removed afterwards. */
  async function sandbox() {
    const name = `kassa_t_${randomBytes(5).toString("hex")}`;
    const folder = await mkdtemp(join(tmpdir(), "kassa-setup-"));
    const settings = join(folder, "config", "kassa.env");
    cleanups.push(async () => {
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name}`);
        await client.query(`DROP ROLE IF EXISTS ${name}`);
      } finally {
        await client.end();
      }
      await rm(folder, { recursive: true, force: true });
    });
    return { name, settings, folder };
  }

  const setup = (settings: string, name: string, env: Record<string, string | undefined> = adminEnv) =>
    runScript("setup-database.mjs", ["--settings", settings, "--role", name, "--database", name], env);

  async function canConnect(settings: string): Promise<boolean> {
    const url = /^DATABASE_URL=(.*)$/m.exec(await readFile(settings, "utf8"))?.[1];
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return (await client.query("SELECT 1 AS ok")).rows[0].ok === 1;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => {});
    }
  }

  it("creates the role and the database, and writes a settings file that connects", async () => {
    const { name, settings } = await sandbox();

    const result = await setup(settings, name);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Created the role "${name}"`);
    expect(result.stdout).toContain(`Created the database "${name}"`);
    const text = await readFile(settings, "utf8");
    expect(text).toMatch(/^NODE_ENV=production$/m);
    expect(text).toMatch(/^HOST=127\.0\.0\.1$/m);
    expect(text).toMatch(/^TRUST_PROXY=127\.0\.0\.1$/m);
    expect(text).not.toContain("CHANGE-ME");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(await canConnect(settings)).toBe(true);
    // The password is in the file, never in what the script says.
    const password = new URL(/^DATABASE_URL=(.*)$/m.exec(text)![1]!).password;
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(result.stdout + result.stderr).not.toContain(password);
  }, 30_000);

  it("makes a role of its own that can build the whole schema, without being allowed more than that", async () => {
    const { name, settings } = await sandbox();
    await setup(settings, name);

    // The way build.ps1 does it: the admin command line with this settings file.
    const migrated = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [`--env-file=${settings}`, "--import", "tsx", "src/admin/cli.ts", "migrate"], {
        cwd: join(repoRoot, "server"),
        env: { ...process.env, DATABASE_URL: undefined },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    const role = (await client.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1", [name])).rows[0];
    await client.end();

    expect(migrated.code, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain("Applied migrations: 0001_users_and_sessions.sql");
    expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  }, 30_000);

  it("keeps what exists when it is run again", async () => {
    const { name, settings } = await sandbox();
    await setup(settings, name);
    const before = await readFile(settings, "utf8");

    const again = await setup(settings, name);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`The role "${name}" exists already.`);
    expect(again.stdout).toContain("Kept the settings file");
    expect(await readFile(settings, "utf8")).toBe(before);
    expect(await canConnect(settings)).toBe(true);
  }, 30_000);

  it("gives a role that was left behind the password of the new file, and a lost database back its role", async () => {
    const { name, settings } = await sandbox();
    // A run that stopped before it wrote the file left the role behind with some other password.
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`CREATE ROLE ${name} LOGIN PASSWORD 'something-else'`);
    await client.end();

    const first = await setup(settings, name);

    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("its password is now the one in the new settings file");
    expect(await canConnect(settings)).toBe(true);

    // The database and the role are lost, the file is not: they come back with the password in the file.
    const before = await readFile(settings, "utf8");
    const cleaner = new pg.Client({ connectionString: admin.toString() });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE ${name}`);
    await cleaner.query(`DROP ROLE ${name}`);
    await cleaner.end();

    const second = await setup(settings, name);

    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain(`Created the role "${name}"`);
    expect(await readFile(settings, "utf8")).toBe(before);
    expect(await canConnect(settings)).toBe(true);
  }, 30_000);

  it("refuses an existing settings file that belongs to another role or database", async () => {
    const { name, settings, folder } = await sandbox();
    await mkdir(join(folder, "config"), { recursive: true });
    await writeFile(settings, "DATABASE_URL=postgres://somebody:pw@127.0.0.1:5432/else\n");

    const result = await setup(settings, name);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("names another role or database");
    expect(await readFile(settings, "utf8")).toBe("DATABASE_URL=postgres://somebody:pw@127.0.0.1:5432/else\n");
  }, 30_000);

  it("says what is missing without the administrator password, and what is wrong with a wrong one", async () => {
    const { name, settings } = await sandbox();

    const missing = await setup(settings, name, { ...adminEnv, PGPASSWORD: "" });
    const wrong = await setup(settings, name, { ...adminEnv, PGPASSWORD: "not the password" });

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("set PGPASSWORD");
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("could not connect to PostgreSQL");
    await expect(readFile(settings, "utf8")).rejects.toThrow();
  }, 30_000);

  it("refuses names that are not plain lower-case words", async () => {
    const { settings } = await sandbox();

    const result = await runScript("setup-database.mjs", ["--settings", settings, "--role", 'x"; DROP ROLE y; --'], adminEnv);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--role must be lower-case letters");
  }, 30_000);
});
