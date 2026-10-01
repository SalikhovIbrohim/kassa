import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/migrate.js";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { adminEnv, adminUrl, runScript, type Run } from "./helpers/run-script.js";
import { createBlankDatabase, startTestApp, type TestApp } from "./helpers/test-app.js";

const DAY = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

/** Where a command on the PATH really is (the PostgreSQL commands are links to a wrapper on Debian). */
async function which(command: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      return await realpath(join(directory, command));
    } catch {
      // not in this folder
    }
  }
  throw new Error(`${command} is not on the PATH: the tests of the copy scripts need the PostgreSQL command line tools`);
}

describe("deploy/backup.mjs and deploy/restore.mjs: copies of the database, and getting them back", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  });

  async function withAdmin<T>(work: (client: pg.Client) => Promise<T>, database = "postgres"): Promise<T> {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  /** Names of the databases of one install: the live one, the kept one, scratch ones. */
  const databasesOf = (name: string) =>
    withAdmin(async (client) =>
      (await client.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1", [name])).rows.map(
        (row) => row.datname as string,
      ),
    );

  /**
   * A machine as the owner's is set up: a role and a database of their own, and the settings file,
   * made by setup-database.mjs, in a folder whose name has a space in it. Everything is removed afterwards.
   */
  async function install() {
    const name = `kassa_b_${randomBytes(4).toString("hex")}`;
    const folder = await mkdtemp(join(tmpdir(), "kassa copies "));
    const settings = join(folder, "config", "kassa.env");
    const copies = join(folder, "copies here");
    cleanups.push(async () => {
      await withAdmin(async (client) => {
        for (const database of await databasesOf(name)) {
          await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(database)} WITH (FORCE)`);
        }
        await client.query(`DROP ROLE IF EXISTS ${name}`);
      });
      await rm(folder, { recursive: true, force: true });
    });

    const setup = await runScript("setup-database.mjs", ["--settings", settings, "--role", name, "--database", name], adminEnv);
    expect(setup.code, setup.stderr).toBe(0);
    const url = /^DATABASE_URL=(.*)$/m.exec(await readFile(settings, "utf8"))![1]!;
    await migrateDatabase(url);
    return { name, folder, settings, copies, url };
  }

  /** The server of this machine, running on its database until the test (or `whileStopped`) stops it. */
  async function serverOf(machine: { url: string }): Promise<TestApp> {
    const app = await startTestApp({ databaseUrl: machine.url });
    cleanups.push(() => app.close());
    return app;
  }

  const backup = (settings: string, args: string[] = [], env: Record<string, string | undefined> = {}) =>
    runScript("backup.mjs", ["--settings", settings, ...args], env);

  const restore = (settings: string, copy: string, mode: "--check" | "--replace", env: Record<string, string | undefined> = adminEnv) =>
    runScript("restore.mjs", ["--settings", settings, "--from", copy, mode], env);

  /** The one copy in a folder. */
  async function theCopy(copies: string): Promise<string> {
    const names = (await readdir(copies)).filter((item) => item.endsWith(".dump"));
    expect(names).toHaveLength(1);
    return join(copies, names[0]!);
  }

  /** A cash book with some history: two currencies, a correction, a deletion, Russian text. */
  async function fillTheBook(app: TestApp) {
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван Петров" });
    await app.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await app.admin.setOpeningBalance("RUB", "1000.00");
    await app.admin.setOpeningBalance("USD", "50.00");
    const ivan = await loginAs(app, "ivan", "correct horse");
    const owner = await loginAs(app, "owner", "long enough pass");

    const record = async (body: Record<string, unknown>) => {
      const id = randomUUID();
      const response = await postJson(app, "/api/operations", { id, ...body }, ivan);
      expect(response.status, await response.clone().text()).toBe(201);
      return id;
    };
    const corrected = await record({ type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17" });
    await record({ type: "income", amountMinor: 12_050, currency: "USD", clientCode: "K18", comment: "за рейс Москва — Ташкент" });
    await record({ type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", recipient: "АЗС №5" });
    const deleted = await record({ type: "expense", amountMinor: 3_000, currency: "RUB", category: "other" });

    const edit = await putJson(
      app,
      `/api/operations/${corrected}`,
      { type: "income", amountMinor: 65_000, currency: "RUB", clientCode: "K17", comment: "и доплата", reason: "уточнил сумму" },
      ivan,
    );
    expect(edit.status, await edit.clone().text()).toBe(200);
    const removal = await deleteRequest(app, `/api/operations/${deleted}`, ivan, { reason: "дубль" });
    expect(removal.status, await removal.clone().text()).toBe(200);
    return { owner, record };
  }

  /** The whole book as the viewer sees it: balances, the journal with deleted entries, every history. */
  async function bookAsSeenBy(app: TestApp, owner: string) {
    const balances = await (await get(app, "/api/balances", owner)).json();
    const journal = await (await get(app, "/api/operations?limit=100&deleted=include", owner)).json();
    const histories: Record<string, unknown> = {};
    for (const operation of journal.operations as Array<{ id: string }>) {
      histories[operation.id] = await (await get(app, `/api/operations/${operation.id}/history`, owner)).json();
    }
    return { balances, journal, histories };
  }

  describe("a copy and a restore, end to end", () => {
    it("gives back the same book after a restore: balances, journal, deleted entries and every history", async () => {
      const machine = await install();
      const { settings, copies, name } = machine;
      const app = await serverOf(machine);
      const { owner, record } = await fillTheBook(app);
      const before = await bookAsSeenBy(app, owner);
      expect((before.journal.operations as unknown[]).length).toBe(4);

      const made = await backup(settings, ["--to", copies]);
      expect(made.code, made.stderr).toBe(0);
      expect(made.stdout).toContain("Copy made:");
      const copy = await theCopy(copies);
      expect(basename(copy)).toMatch(new RegExp(`^${name}-\\d{8}-\\d{6}\\.dump$`));
      expect((await stat(copy)).size).toBeGreaterThan(1000);

      // The day goes on: one more income after the copy was made.
      await record({ type: "income", amountMinor: 77_700, currency: "RUB", clientCode: "K99" });
      const later = await bookAsSeenBy(app, owner);
      expect(later).not.toEqual(before);

      // The copy can be tried without touching anything that is in use.
      const tried = await restore(settings, copy, "--check");
      expect(tried.code, tried.stderr).toBe(0);
      expect(tried.stdout).toContain("The copy holds 2 users, 4 operations (1 of them deleted)");
      expect(tried.stdout).toContain("The copy can be restored.");
      expect(await databasesOf(name)).toEqual([name]);
      expect(await bookAsSeenBy(app, owner)).toEqual(later);

      // While the server runs, the database is not replaced.
      const refused = await restore(settings, copy, "--replace");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("is in use");
      expect(await databasesOf(name)).toEqual([name]);
      expect(await bookAsSeenBy(app, owner)).toEqual(later);

      // Stop the server, restore, start it again: the book is as it was when the copy was made.
      let replaced: Run | undefined;
      await app.whileStopped(async () => {
        replaced = await restore(settings, copy, "--replace");
      });
      expect(replaced!.code, replaced!.stderr).toBe(0);
      expect(replaced!.stdout).toContain(`Restored: the database "${name}" now holds the copy.`);
      const ownerAgain = await loginAs(app, "owner", "long enough pass");
      expect(await bookAsSeenBy(app, ownerAgain)).toEqual(before);

      // The database that was live is still there, with the entry made after the copy.
      const databases = await databasesOf(name);
      expect(databases).toHaveLength(2);
      const kept = databases.find((database) => database !== name)!;
      expect(kept).toMatch(new RegExp(`^${name}_before_restore_\\d{8}_\\d{6}$`));
      expect(replaced!.stdout).toContain(`kept as "${kept}"`);
      expect(await withAdmin((client) => client.query("SELECT count(*)::int AS n FROM operations"), kept).then((r) => r.rows[0].n)).toBe(5);

      // What the database promised still holds in the restored one, and work goes on in it.
      await expect(app.execute("DELETE FROM operations")).rejects.toThrow();
      await expect(app.execute("UPDATE operations SET amount_minor = amount_minor + 1")).rejects.toThrow();
      const cashier = await loginAs(app, "ivan", "correct horse");
      const next = await postJson(app, "/api/operations", { id: randomUUID(), type: "income", amountMinor: 100, currency: "RUB", clientCode: "K1" }, cashier);
      expect(next.status).toBe(201);
    }, 120_000);

    it("restores on a machine where the database does not exist yet, as after losing the disk", async () => {
      const { settings, copies, name, url } = await install();
      const made = await backup(settings, ["--to", copies]);
      expect(made.code, made.stderr).toBe(0);
      await withAdmin((client) => client.query(`DROP DATABASE ${name}`));

      const result = await restore(settings, await theCopy(copies), "--replace");

      expect(result.code, result.stderr).toBe(0);
      expect(await databasesOf(name)).toEqual([name]);
      expect(result.stdout).not.toContain("is kept as");
      // The role of the settings file owns it and can read it.
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      expect((await client.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(4);
      await client.end();
    }, 60_000);
  });

  describe("making a copy", () => {
    it("takes the folder and the number of copies from the settings file, and a path with spaces is fine", async () => {
      const { settings, copies, name } = await install();
      await writeFile(settings, `${await readFile(settings, "utf8")}\nBACKUP_DIR=${copies}\nBACKUP_KEEP=2\n`);
      await mkdir(copies, { recursive: true });
      for (const day of ["20200101", "20200102", "20200103"]) await writeFile(join(copies, `${name}-${day}-000000.dump`), "old");

      const result = await backup(settings);

      expect(result.code, result.stderr).toBe(0);
      const left = (await readdir(copies)).sort();
      expect(left).toHaveLength(2);
      expect(left[0]).toBe(`${name}-20200103-000000.dump`);
      expect(left[1]).toMatch(new RegExp(`^${name}-2\\d{7}-\\d{6}\\.dump$`));
      expect(result.stdout).toContain("Deleted 2 old copies (the newest 2 are kept).");
    }, 60_000);

    it("keeps the newest copies, deletes only older copies of this database, and clears an unfinished copy of an earlier day", async () => {
      const { settings, copies, name } = await install();
      await mkdir(join(copies, "a folder"), { recursive: true });
      const notOurs = ["notes.txt", "other-20200101-000000.dump", `${name}-20200101-000000.dump.bak`, `${name}-latest.dump`, `${name}x-20200101-000000.dump`];
      for (const file of notOurs) await writeFile(join(copies, file), "not ours");
      for (const day of ["20200101", "20200102", "20200103"]) await writeFile(join(copies, `${name}-${day}-000000.dump`), "old");
      const staleHalf = join(copies, `${name}-20200105-000000.dump.partial`);
      const freshHalf = join(copies, `${name}-20991231-000000.dump.partial`);
      await writeFile(staleHalf, "cut off");
      await writeFile(freshHalf, "being written");
      await utimes(staleHalf, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));

      const result = await backup(settings, ["--to", copies, "--keep", "2"]);

      expect(result.code, result.stderr).toBe(0);
      const left = (await readdir(copies)).sort();
      const copyName = new RegExp(`^${name}-\\d{8}-\\d{6}\\.dump$`);
      const made = left.filter((item) => copyName.test(item) && !item.startsWith(`${name}-2020`));
      expect(made).toHaveLength(1);
      expect(left.filter((item) => !made.includes(item))).toEqual(
        [...notOurs, "a folder", basename(freshHalf), `${name}-20200103-000000.dump`].sort(),
      );
      expect(result.stdout).toContain("an unfinished copy from an earlier run");
    }, 60_000);

    it("never deletes the copy it has just made, even when the clock was set back and older copies look newer", async () => {
      const { settings, copies, name } = await install();
      await mkdir(copies, { recursive: true });
      for (const year of ["2098", "2099"]) await writeFile(join(copies, `${name}-${year}0101-000000.dump`), "from the future");

      const result = await backup(settings, ["--to", copies, "--keep", "1"]);

      expect(result.code, result.stderr).toBe(0);
      const left = await readdir(copies);
      expect(left).toHaveLength(2);
      expect(left).toContain(`${name}-20990101-000000.dump`);
      expect(left.some((item) => !item.includes("-209"))).toBe(true);
    }, 60_000);

    it("finds pg_dump in the folder it is told about, also when that folder has a space in its name", async () => {
      const { settings, copies, folder } = await install();
      const tools = join(folder, "pg tools", "bin");
      await mkdir(tools, { recursive: true });
      for (const tool of ["pg_dump", "pg_restore"]) await symlink(await which(tool), join(tools, tool));

      const withFlag = await backup(settings, ["--to", copies, "--pg-bin", tools], { PATH: "" });
      const nowhere = await backup(settings, ["--to", copies], { PATH: "" });
      const wrongFolder = await backup(settings, ["--to", copies, "--pg-bin", join(folder, "no such folder")], { PATH: "" });

      expect(withFlag.code, withFlag.stderr).toBe(0);
      expect(nowhere.code).toBe(1);
      expect(nowhere.stderr).toContain("pg_dump");
      expect(nowhere.stderr).toContain("--pg-bin");
      expect(wrongFolder.code).toBe(1);
      expect(wrongFolder.stderr).toContain("is not in");
    }, 60_000);

    it("adds a line to the log file for every run: the copy made, or why not", async () => {
      const { settings, copies, folder } = await install();
      const log = join(folder, "logs", "backup.log");

      const good = await backup(settings, ["--to", copies, "--log", log]);
      const text = await readFile(settings, "utf8");
      await writeFile(settings, text.replace(/(DATABASE_URL=postgres:\/\/[^:]+:)[^@]+@/, "$1wrong-password@"));
      const bad = await backup(settings, ["--to", copies, "--log", log]);
      const status = await backup(settings, ["--to", copies, "--status", "--log", log]);

      expect(good.code, good.stderr).toBe(0);
      expect(bad.code).toBe(1);
      expect(status.code, status.stderr).toBe(0);
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}OK {6}Copy made: .*\.dump \(/);
      expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}FAILED {2}pg_dump failed .*password authentication failed/);
    }, 60_000);

    it("makes two copies when it is started twice at once, and never writes one over the other", async () => {
      const { settings, copies } = await install();

      const [first, second] = await Promise.all([backup(settings, ["--to", copies]), backup(settings, ["--to", copies])]);

      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      const names = (await readdir(copies)).sort();
      expect(names).toHaveLength(2);
      expect(names.every((item) => item.endsWith(".dump"))).toBe(true);
      for (const name of names) {
        const listing = await execFileAsync("pg_restore", ["--list", join(copies, name)]);
        expect(listing.stdout).toContain("TABLE DATA public operations");
      }
    }, 60_000);

    it("restricts who can read the copies, as far as the file system lets it", async () => {
      const { settings, copies } = await install();

      const result = await backup(settings, ["--to", copies]);

      expect(result.code, result.stderr).toBe(0);
      if (process.platform !== "win32") {
        expect((await stat(copies)).mode & 0o077).toBe(0);
        expect((await stat(await theCopy(copies))).mode & 0o077).toBe(0);
      }
    }, 60_000);
  });

  describe("when a copy cannot be made, it says so and leaves nothing that looks like a copy", () => {
    /** A pg_dump that does what `script` says, with the real pg_restore next to it. */
    async function fakeDump(folder: string, script: string): Promise<string> {
      const tools = join(folder, "fake tools");
      await mkdir(tools, { recursive: true });
      await writeFile(join(tools, "pg_dump"), `#!/bin/sh\n${script}\n`);
      await chmod(join(tools, "pg_dump"), 0o755);
      await symlink(await which("pg_restore"), join(tools, "pg_restore"));
      return tools;
    }

    it("exits with 1 when the database refuses the password, and keeps the copies that were there", async () => {
      const { settings, copies, name } = await install();
      await mkdir(copies, { recursive: true });
      await writeFile(join(copies, `${name}-20200101-000000.dump`), "yesterday's");
      const text = await readFile(settings, "utf8");
      await writeFile(settings, text.replace(/(DATABASE_URL=postgres:\/\/[^:]+:)[^@]+@/, "$1wrong-password@"));

      const result = await backup(settings, ["--to", copies, "--keep", "1"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("pg_dump failed");
      expect(result.stderr).toMatch(/password authentication failed/i);
      expect(await readdir(copies)).toEqual([`${name}-20200101-000000.dump`]);
    }, 60_000);

    it("exits with 1 when pg_dump fails half way, and removes the unfinished file", async () => {
      const { settings, copies, folder } = await install();
      const tools = await fakeDump(folder, 'while [ "$1" != "--file" ]; do shift; done; echo partial > "$2"; echo "disk is full" >&2; exit 3');

      const result = await backup(settings, ["--to", copies, "--pg-bin", tools]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exit code 3");
      expect(result.stderr).toContain("disk is full");
      expect(await readdir(copies)).toEqual([]);
    }, 60_000);

    it("exits with 1 when pg_dump says it succeeded but the file is not a copy that can be read", async () => {
      const { settings, copies, folder } = await install();
      const tools = await fakeDump(folder, 'while [ "$1" != "--file" ]; do shift; done; echo "this is not a dump" > "$2"');

      const result = await backup(settings, ["--to", copies, "--pg-bin", tools]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("cannot be read back");
      expect(await readdir(copies)).toEqual([]);
    }, 60_000);

    it("exits with 1 for a database that is not Kassa's: a copy of the wrong database is no copy", async () => {
      const { settings, copies } = await install();
      const blank = await createBlankDatabase();
      cleanups.push(() => blank.drop());
      const text = await readFile(settings, "utf8");
      const url = new URL(/^DATABASE_URL=(.*)$/m.exec(text)![1]!);
      url.pathname = new URL(blank.url).pathname;
      await writeFile(settings, text.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url.toString()}`));

      const result = await backup(settings, ["--to", copies]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not hold the operations table");
      expect(await readdir(copies)).toEqual([]);
    }, 60_000);

    it("exits with 1 when the folder cannot be made", async () => {
      const { settings, folder } = await install();
      const aFile = join(folder, "a file");
      await writeFile(aFile, "x");

      const result = await backup(settings, ["--to", join(aFile, "inside")]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Cannot create the folder");
    }, 60_000);

    it("asks for what is missing, and exits with 2 when it is used wrongly", async () => {
      const { settings, copies, folder } = await install();

      const noFolder = await backup(settings);
      const relative = await backup(settings, ["--to", "copies"]);
      const noSettingsFile = await backup(join(folder, "nothing.env"), ["--to", copies]);
      const noSetting = await runScript("backup.mjs", []);
      const zero = await backup(settings, ["--to", copies, "--keep", "0"]);
      const unknown = await backup(settings, ["--to", copies, "--frobnicate"]);

      expect(noFolder.code).toBe(1);
      expect(noFolder.stderr).toContain("BACKUP_DIR");
      expect(relative.code).toBe(1);
      expect(relative.stderr).toContain("is not a full path");
      expect(noSettingsFile.code).toBe(1);
      expect(noSettingsFile.stderr).toContain("it does not exist");
      expect(noSetting.code).toBe(2);
      expect(noSetting.stderr).toContain("--settings is required");
      expect(zero.code).toBe(2);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("Usage:");
    }, 60_000);
  });

  describe("--status: is the nightly copy working?", () => {
    it("fails when there is no copy, passes after a fresh one, and fails again when the newest is too old", async () => {
      const { settings, copies } = await install();

      const none = await backup(settings, ["--to", copies, "--status"]);
      await backup(settings, ["--to", copies]);
      const fresh = await backup(settings, ["--to", copies, "--status"]);
      const copy = await theCopy(copies);
      await utimes(copy, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
      const stale = await backup(settings, ["--to", copies, "--status"]);
      const lenient = await backup(settings, ["--to", copies, "--status", "--max-age-hours", "100"]);

      expect(none.code).toBe(1);
      expect(none.stderr).toContain("There is no copy");
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain("Newest copy:");
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("older than 26 hours");
      expect(lenient.code, lenient.stderr).toBe(0);
    }, 60_000);
  });

  describe("restoring: a copy that cannot be used changes nothing", () => {
    /** The live database holds a user, so that a restore that touched it would show. The server is stopped. */
    async function installWithACopy() {
      const machine = await install();
      const app = await startTestApp({ databaseUrl: machine.url });
      try {
        await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
        await app.admin.setOpeningBalance("RUB", "10.00");
      } finally {
        await app.close();
      }
      const made = await backup(machine.settings, ["--to", machine.copies]);
      expect(made.code, made.stderr).toBe(0);
      return { ...machine, copy: await theCopy(machine.copies) };
    }

    /** The live database is as it was, and no scratch database is left. */
    async function expectUntouched(machine: Awaited<ReturnType<typeof installWithACopy>>) {
      expect(await databasesOf(machine.name)).toEqual([machine.name]);
      const users = await withAdmin((client) => client.query("SELECT login FROM users"), machine.name);
      expect(users.rows).toEqual([{ login: "ivan" }]);
    }

    it("refuses a file that is not a copy, in both modes", async () => {
      const machine = await installWithACopy();
      const garbage = join(machine.folder, "garbage.dump");
      await writeFile(garbage, randomBytes(4000));

      for (const mode of ["--check", "--replace"] as const) {
        const result = await restore(machine.settings, garbage, mode);
        expect(result.code, mode).toBe(1);
        expect(result.stderr, mode).toContain("is not a copy that can be restored");
      }
      await expectUntouched(machine);
    }, 60_000);

    it("refuses a file that does not exist", async () => {
      const machine = await installWithACopy();

      const result = await restore(machine.settings, join(machine.folder, "gone.dump"), "--check");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("There is no file");
    }, 60_000);

    it("stops at a copy that is damaged half way, removes the scratch database, and leaves the live one alone", async () => {
      const machine = await installWithACopy();
      const damaged = join(machine.folder, "damaged.dump");
      await writeFile(damaged, await readFile(machine.copy));
      await truncate(damaged, Math.floor((await stat(machine.copy)).size * 0.6));

      for (const mode of ["--check", "--replace"] as const) {
        const result = await restore(machine.settings, damaged, mode);
        expect(result.code, `${mode}: ${result.stdout}`).toBe(1);
        expect(result.stderr, mode).toMatch(/could not be restored|is not a copy that can be restored/);
      }
      await expectUntouched(machine);
    }, 60_000);

    it("refuses a copy of a database that is not Kassa's", async () => {
      const machine = await installWithACopy();
      const blank = await createBlankDatabase();
      cleanups.push(() => blank.drop());
      const client = new pg.Client({ connectionString: blank.url });
      await client.connect();
      await client.query("CREATE TABLE something (id int)");
      await client.end();
      const other = join(machine.folder, "something-else.dump");
      await execFileAsync("pg_dump", ["--format=custom", "--file", other, "--dbname", blank.url]);

      for (const mode of ["--check", "--replace"] as const) {
        const result = await restore(machine.settings, other, mode);
        expect(result.code, mode).toBe(1);
        expect(result.stderr, mode).toContain("is not a copy of the Kassa database");
      }
      await expectUntouched(machine);
    }, 60_000);

    it("will not put in a copy from a newer version of Kassa than the installed one, but can still be asked to look at it", async () => {
      const machine = await installWithACopy();
      await withAdmin((client) => client.query("INSERT INTO schema_migrations (name) VALUES ('9999_from_the_future.sql')"), machine.name);
      await rm(machine.copies, { recursive: true, force: true });
      const made = await backup(machine.settings, ["--to", machine.copies]);
      expect(made.code, made.stderr).toBe(0);
      const copy = await theCopy(machine.copies);
      await withAdmin((client) => client.query("DELETE FROM schema_migrations WHERE name = '9999_from_the_future.sql'"), machine.name);

      const check = await restore(machine.settings, copy, "--check");
      const replace = await restore(machine.settings, copy, "--replace");

      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain("Warning: This copy was made by a newer version of Kassa (9999_from_the_future.sql)");
      expect(replace.code).toBe(1);
      expect(replace.stderr).toContain("newer version of Kassa");
      await expectUntouched(machine);
    }, 60_000);

    it("says what is wrong when the administrator password is missing or wrong, and touches nothing", async () => {
      const machine = await installWithACopy();

      const missing = await restore(machine.settings, machine.copy, "--check", { ...adminEnv, PGPASSWORD: "" });
      const wrong = await restore(machine.settings, machine.copy, "--check", { ...adminEnv, PGPASSWORD: "not the password" });

      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("PGPASSWORD");
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain("Could not connect to PostgreSQL");
      await expectUntouched(machine);
    }, 60_000);

    it("asks for exactly one of --check and --replace, and exits with 2 otherwise", async () => {
      const machine = await installWithACopy();

      const neither = await runScript("restore.mjs", ["--settings", machine.settings, "--from", machine.copy]);
      const both = await runScript("restore.mjs", ["--settings", machine.settings, "--from", machine.copy, "--check", "--replace"]);
      const noFrom = await runScript("restore.mjs", ["--settings", machine.settings, "--check"]);

      for (const result of [neither, both, noFrom]) {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("Usage:");
      }
      await expectUntouched(machine);
    }, 60_000);
  });
});
