import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("onec-look reads a base it has never written to and changes nothing in it, with the address and the login alone", async () => {
    const url = await world();
    const result = await runCli(["onec-look"], { DATABASE_URL: url, ONEC_ODATA_URL: onec.url, ONEC_ODATA_USER: "kassa", ONEC_ODATA_PASSWORD: "secret" });
    expect(result.code, result.stderr).toBe(0);
    // What this base lets be read is printed; what it does not is said and passed over.
    expect(result.stdout).toContain("=== Catalog_Контрагенты ===");
    expect(result.stdout).toContain("=== Catalog_СтатьиДвиженияДенежныхСредств ===");
    expect(result.stdout).toMatch(/не прочитано: список объектов/);
    expect(result.stdout).toContain("В базе ничего не изменено.");
    expect(onec.documents).toHaveLength(0);
    // The password is nowhere in what is printed.
    expect(result.stdout + result.stderr).not.toContain("secret");

    // Without the address there is nothing to look at.
    const none = await runCli(["onec-look"], { DATABASE_URL: url });
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("ONEC_ODATA_URL");
  });

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

describe("admin command line: set-categories", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function world(file: unknown) {
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    const folder = mkdtempSync(join(tmpdir(), "kassa-categories-"));
    cleanups.push(async () => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, "categories.json");
    // A file as Notepad saves it: with the mark of UTF-8 in front.
    writeFileSync(path, `\uFEFF${typeof file === "string" ? file : JSON.stringify(file)}`, "utf8");
    const env = { DATABASE_URL: database.url, KASSAS: "moscow:USD,andijan:USD,tashkent:USD" };
    // The lists a new installation starts with.
    await runCli(["migrate"], env);
    const rows = async () => {
      const pool = new pg.Pool({ connectionString: database.url, max: 1 });
      try {
        const found = await pool.query(
          `SELECT code, kind, label, archived, requires_client, requires_trip, requires_counterparty, requires_employee, city, notify_group, counts_as_cost
             FROM categories ORDER BY kind DESC, sort_order, code`,
        );
        return found.rows as Array<Record<string, unknown>>;
      } finally {
        await pool.end();
      }
    };
    return { path, env, rows };
  }

  const lists = {
    income: [
      { label: "Оплата от покупателей", code: "client_payment", requiresClient: true },
      { label: "Субаренда" },
      { label: "Прочее", requiresEmployee: true },
    ],
    expense: [
      { label: "Толкач", city: "tashkent", requiresTrip: true },
      { label: "Обед", city: "andijan" },
      { label: "Оплата поставщикам (подрядчикам)", requiresCounterparty: true },
    ],
  };

  it("makes the lists those of the file, in its order, and archives the rest without deleting it", async () => {
    const { path, env, rows } = await world(lists);
    const before = await rows();

    const result = await runCli(["set-categories", "--file", path], env);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const after = await rows();
    const live = after.filter((row) => !row.archived);
    expect(live.map((row) => `${row.kind} ${row.label} ${row.city ?? "-"}`)).toEqual([
      "income Оплата от покупателей -",
      "income Субаренда -",
      "income Прочее -",
      "expense Толкач tashkent",
      "expense Обед andijan",
      "expense Оплата поставщикам (подрядчикам) -",
    ]);
    // The payment of a client is the category it was, under its new name; the income «Прочее» is the one that was there.
    expect(live[0]).toMatchObject({ code: "client_payment", requires_client: true, notify_group: true });
    expect(live[2]).toMatchObject({ code: "other_income", requires_employee: true, notify_group: false });
    expect(live[3]).toMatchObject({ requires_trip: true, requires_client: false, notify_group: true, counts_as_cost: true });
    expect(live[5]).toMatchObject({ requires_counterparty: true });
    // A new income is not told to the group, as the first incomes were not.
    expect(live[1]).toMatchObject({ notify_group: false });
    // Nothing is deleted: every category there was is still there, the ones not in the file in the archive.
    expect(after.length).toBe(before.length + 4);
    for (const row of before) expect(after.some((item) => item.code === row.code)).toBe(true);
    expect(after.find((row) => row.code === "fuel_road")).toMatchObject({ archived: true, label: "Топливо и дорога" });
    expect(result.stdout).toContain("archived  expense  Топливо и дорога");
    expect(result.stdout).toContain("kept      income   Оплата от покупателей (was «Оплата от клиента»)");
    expect(result.stdout).toContain("added     expense  Толкач");

    // The same file again changes nothing.
    const again = await runCli(["set-categories", "--file", path], env);
    expect(again.code).toBe(0);
    expect(again.stdout).not.toMatch(/archived|added/);
    expect(await rows()).toEqual(after);
  }, 30_000);

  it("changes nothing when the file names a city that is no cash desk, a field it does not know, or a code that is not there", async () => {
    for (const [file, said] of [
      [{ ...lists, expense: [{ label: "Обед", city: "fergana" }] }, /"city" must be moscow or andijan or tashkent/],
      [{ ...lists, expense: [{ label: "Обед", trip: true }] }, /"trip" is not known/],
      [{ ...lists, income: [{ label: "Оплата", code: "no_such" }] }, /no category with the code no_such/],
      [{ ...lists, income: [{ label: "Оплата", code: "fuel_road" }] }, /fuel_road is an expense/],
      [{ ...lists, income: [] }, /"income" must be a list with at least one category/],
      [{ ...lists, expense: [{ label: "Обед" }, { label: "обед" }] }, /«обед» is in the list twice/],
      ["{ not json", /could not be read as JSON/],
    ] as Array<[unknown, RegExp]>) {
      const { path, env, rows } = await world(file);
      const before = await rows();
      const result = await runCli(["set-categories", "--file", path], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(said);
      expect(await rows()).toEqual(before);
    }
  }, 120_000);

  it("says so when no category of the file is the payment of a client", async () => {
    const { path, env } = await world({ income: [{ label: "Оплата от покупателей", requiresClient: true }], expense: [{ label: "Обед" }] });
    const result = await runCli(["set-categories", "--file", path], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"code": "client_payment"');
  }, 30_000);
});

describe("admin command line: import-history", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** The history file of a business with codes of digits, three desks of dollars and two warehouses, on a database of its own. */
  async function world(file: unknown) {
    const database = await createBlankDatabase();
    const folder = mkdtempSync(join(tmpdir(), "kassa-history-"));
    cleanups.push(async () => {
      rmSync(folder, { recursive: true, force: true });
      await database.drop();
    });
    const path = join(folder, "history.json");
    // A file saved by Notepad starts with a byte order mark: read all the same.
    writeFileSync(path, `﻿${JSON.stringify(file)}`);
    const env = { DATABASE_URL: database.url, KASSAS: "moscow:USD,andijan:USD,tashkent:USD", CLIENT_CODES: "digits", WAREHOUSES: "andijan,kokand" };
    return { path, env, url: database.url };
  }

  const history = {
    clients: [{ code: "1", name: "Улугбек", openingDebtMinor: 2_439_800 }, { code: "132", name: "Иброхим" }],
    trips: [{ number: 67, arrivalDay: "2026-01-03", sums: [{ code: "1", amountMicro: 2_894_850_000 }, { code: "132", amountMicro: 4_285_728_000 }] }],
    payments: [{ code: "1", day: "2026-01-05", amountMinor: 108_000, kassa: "moscow" }, { code: "132", day: "2026-02-06", amountMinor: 300_000, kassa: "tashkent" }],
    waybills: [{ number: 248, status: "in_transit", loadingDay: "2026-11-07", lines: [{ warehouse: "kokand", truckPart: "head", code: "132", weightG: 1_578_300, priceMilli: 1400 }] }],
    // What the card file says: sums with a third decimal, where the debts here are whole cents.
    control: [
      { month: "2026-01", openingMinor: 2_439_800, chargedMinor: 718_058, paidMinor: 108_000, closingMinor: 3_049_858 },
      { month: "2026-02", openingMinor: 3_049_858, chargedMinor: 0, paidMinor: 300_000, closingMinor: 2_749_858 },
    ],
  };

  it("loads the file and prints the debts month by month next to the control sheet of the file", async () => {
    const { path, env, url } = await world(history);
    // The trips of the history are written down under an admin: there has to be one.
    const early = await runCli(["import-history", "--file", path], env);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("There is no admin yet");
    expect((await runCli(["create-user", "--login", "mudir", "--role", "admin"], { ...env, KASSA_PASSWORD: "admin password" })).code).toBe(0);

    const result = await runCli(["import-history", "--file", path], env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Clients: 2 added, 0 were there");
    expect(result.stdout).toContain("Trips of before: 1 added, 0 were there, 0 taken away; 2 sums of clients.");
    expect(result.stdout).toContain("Payments of before: 2.");
    expect(result.stdout).toContain("Trip 248 on the road: 1 lines (made).");
    expect(result.stdout).toMatch(/2026-01\s+24398\.00\s+7180\.58\s+1080\.00\s+30498\.58\s+30498\.58\s+the same/);
    expect(result.stdout).toMatch(/2026-02\s+30498\.58\s+0\.00\s+3000\.00\s+27498\.58\s+27498\.58\s+the same/);
    expect(result.stdout).toContain("The debts agree with the control sheet of the file");
    expect(result.stdout).toContain("All the clients owe 27498.58 now: nothing was entered here since the file was closed.");

    // The cash desk takes a payment of a client after the file was closed: the history still agrees with the file,
    // which knows nothing of it, and what the clients owe now is less by it.
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await pool.query(
        `INSERT INTO operations (id, kind, amount_minor, currency, category, client_code, client_code_key, author_id, created_at, kassa)
         SELECT gen_random_uuid(), 'income', 114300, 'USD', 'client_payment', '132 Иброхим', '132 иброхим', id, '2026-11-17T10:00:00Z', 'moscow' FROM users LIMIT 1`,
      );
    } finally {
      await pool.end();
    }

    // The file again: nothing is doubled.
    const again = await runCli(["import-history", "--file", path, "--login", "mudir"], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Clients: 0 added, 2 were there");
    expect(again.stdout).toContain("Trips of before: 0 added, 1 were there");
    expect(again.stdout).toContain("Trip 248 on the road: 0 lines (left as it is: it has 1 lines already).");
    expect(again.stdout).toMatch(/2026-02\s+30498\.58\s+0\.00\s+3000\.00\s+27498\.58\s+27498\.58\s+the same/);
    expect(again.stdout).toContain("The debts agree with the control sheet of the file");
    expect(again.stdout).toContain("All the clients owe 26355.58 now: 1143.00 less than the history closes with, by what was entered here since");
  }, 60_000);

  it("says so, loudly, when the debts do not come to what the control sheet of the file says", async () => {
    const off = { ...history, control: [{ month: "2026-01", openingMinor: 2_439_800, chargedMinor: 718_058, paidMinor: 108_000, closingMinor: 3_549_858 }] };
    const { path, env } = await world(off);
    expect((await runCli(["create-user", "--login", "mudir", "--role", "admin"], { ...env, KASSA_PASSWORD: "admin password" })).code).toBe(0);
    const result = await runCli(["import-history", "--file", path], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/2026-01 .*apart by -5000\.00/);
    expect(result.stdout).toContain("THE DEBTS DO NOT AGREE");
  }, 60_000);

  it("refuses a file it cannot read, a business without warehouses, and a file that cannot be right", async () => {
    const { path, env } = await world({ ...history, clients: [{ code: "1", name: "" }] });
    expect((await runCli(["create-user", "--login", "mudir", "--role", "admin"], { ...env, KASSA_PASSWORD: "admin password" })).code).toBe(0);
    const nameless = await runCli(["import-history", "--file", path], env);
    expect(nameless.code).toBe(1);
    expect(nameless.stderr).toContain("a client has a name");
    const missing = await runCli(["import-history", "--file", join(path, "no-such.json")], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot be read");
    const noTrips = await runCli(["import-history", "--file", path], { ...env, WAREHOUSES: undefined });
    expect(noTrips.code).toBe(1);
    expect(noTrips.stderr).toContain("keeps no trips");
    expect((await runCli(["import-history"], env)).code).toBe(1);
  }, 60_000);
});
