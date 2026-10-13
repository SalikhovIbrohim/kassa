import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { AdminError } from "../src/admin/users.js";
import { migrate } from "../src/migrate.js";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { createBlankDatabase, startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

type Entry = Record<string, unknown>;

/** The admin is a cashier who may also reconcile the cash desk, and nothing of the owner's. */
describe("the admin role", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "anvar", password: "admin pass word", role: "admin", displayName: "Анвар" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      anvar: await loginAs(started, "anvar", "admin pass word"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });

  it("says who they are: the role is admin", async () => {
    const { started, anvar } = await desk();

    expect(await (await get(started, "/api/me", anvar)).json()).toMatchObject({ user: { login: "anvar", role: "admin" } });
  });

  it("enters entries, and corrects and deletes their own like a cashier", async () => {
    const { started, anvar } = await desk();
    const body = income();

    expect((await postJson(started, "/api/operations", body, anvar)).status).toBe(201);
    const edit = await putJson(started, `/api/operations/${body.id}`, { ...body, id: undefined, amountMinor: 60_000, reason: "опечатка" }, anvar);
    expect(edit.status).toBe(200);
    expect((await deleteRequest(started, `/api/operations/${body.id}`, anvar, { reason: "дубль" })).status).toBe(200);
  });

  it("does not correct or delete a colleague's entry, as nobody else does", async () => {
    const { started, anvar, ivan } = await desk();
    const theirs = income();
    await postJson(started, "/api/operations", theirs, ivan);

    const edit = await putJson(started, `/api/operations/${theirs.id}`, { ...theirs, id: undefined, amountMinor: 1_000 }, anvar);
    const removed = await deleteRequest(started, `/api/operations/${theirs.id}`, anvar);

    expect(edit.status).toBe(403);
    expect(removed.status).toBe(403);
  });

  it("stands above the owner: reads what the owner reads and settles what the owner settles", async () => {
    const { started, anvar, ivan } = await desk();
    const kept = income();
    const gone = income({ clientCode: "K18" });
    await postJson(started, "/api/operations", kept, ivan);
    await postJson(started, "/api/operations", gone, ivan);
    await deleteRequest(started, `/api/operations/${gone.id}`, ivan);

    expect((await get(started, "/api/summary", anvar)).status).toBe(200);
    expect((await get(started, `/api/operations/${kept.id}/history`, anvar)).status).toBe(200);
    expect((await get(started, "/api/cashiers", anvar)).status).toBe(200);
    expect((await get(started, "/api/reconciliations", anvar)).status).toBe(200);
    const withDeleted = await (await get(started, "/api/operations?deleted=include", anvar)).json();
    expect(withDeleted.operations.map((item: { id: string }) => item.id).sort()).toEqual([kept.id, gone.id].sort());
    const category = await patchJson(started, "/api/admin/categories/fuel_road", { notifyGroup: false }, anvar);
    expect(category.status).toBe(200);
  });

  it("is what a cashier is not: the cashier gets none of that", async () => {
    const { started, ivan, anvar } = await desk();
    const body = income();
    await postJson(started, "/api/operations", body, anvar);

    for (const path of ["/api/summary", `/api/operations/${body.id}/history`, "/api/cashiers", "/api/reconciliations", "/api/operations?deleted=include"]) {
      expect((await get(started, path, ivan)).status, path).toBe(403);
    }
    expect((await patchJson(started, "/api/admin/categories/fuel_road", { notifyGroup: false }, ivan)).status).toBe(403);
  });

  it("is among the people the owner can filter the journal by", async () => {
    const { started, owner } = await desk();

    const { cashiers } = await (await get(started, "/api/cashiers", owner)).json();

    expect(cashiers.map((item: { login: string }) => item.login).sort()).toEqual(["anvar", "ivan"]);
  });

  it("is given to a cashier, and taken away, by the administrator of the server: it holds from their next request", async () => {
    const { started, ivan } = await desk();
    const count = { id: randomUUID(), counted: [{ currency: "RUB", amountMinor: 0 }, { currency: "USD", amountMinor: 0 }] };
    expect((await postJson(started, "/api/reconciliations", count, ivan)).status).toBe(403);

    await started.admin.setRole("IVAN", "head_cashier");
    expect((await postJson(started, "/api/reconciliations", count, ivan)).status).toBe(201);
    expect(await (await get(started, "/api/me", ivan)).json()).toMatchObject({ user: { role: "head_cashier" } });

    await started.admin.setRole("ivan", "cashier");
    expect((await postJson(started, "/api/reconciliations", { ...count, id: randomUUID() }, ivan)).status).toBe(403);
  });

  it("is a role the command line knows: only the four roles, and only for a user who is there", async () => {
    const { started } = await desk();

    await expect(started.admin.setRole("ivan", "boss")).rejects.toThrow(AdminError);
    await expect(started.admin.setRole("nobody", "admin")).rejects.toThrow(/No user with login "nobody"/);
    await expect(started.admin.createUser({ login: "kto", password: "some long pass", role: "boss" as never })).rejects.toThrow(/cashier", "head_cashier", "admin" or "viewer/);
  });

  it("takes an entry from a phone that was offline and still names a shift: the shifts are gone, the entry is not refused", async () => {
    const { started, ivan } = await desk();
    const body = { ...income(), shiftId: randomUUID() };

    const response = await postJson(started, "/api/operations", body, ivan);

    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("operation.shiftId");
  });
});

describe("the shifts that were closed before they were taken away", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("stay in the books as counts of the cash: the same balances and totals, now read from the reconciliations", async () => {
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    const pool = new pg.Pool({ connectionString: database.url, max: 2 });
    try {
      // The database as the version with shifts left it: every migration before this one.
      const directory = new URL("../migrations/", import.meta.url);
      const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
      const before = files.filter((name) => name < "0013");
      await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const name of before) {
        await pool.query(await readFile(new URL(name, directory), "utf8"));
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      }
      const user = (await pool.query<{ id: string }>("INSERT INTO users (login, display_name, password_hash, role) VALUES ('ivan', 'Иван', 'x', 'cashier') RETURNING id")).rows[0]!.id;
      await pool.query("INSERT INTO opening_balances (currency, amount_minor) VALUES ('RUB', 100000), ('USD', 5000)");
      const shift = (await pool.query<{ id: string }>(
        "INSERT INTO shifts (cashier_id, opened_at) VALUES ($1, '2026-03-05T08:00:00Z') RETURNING id", [user])).rows[0]!.id;
      await pool.query(
        `INSERT INTO shift_balances (shift_id, currency, opening_minor, calculated_minor, actual_minor, difference_minor)
         VALUES ($1, 'RUB', 100000, 140000, 139000, -1000), ($1, 'USD', 5000, 7000, 7500, 500)`, [shift]);
      await pool.query("UPDATE shifts SET closed_at = '2026-03-05T15:00:00Z', closed_by = $2 WHERE id = $1", [shift, user]);
      // A shift that was open and never counted has no count to keep.
      await pool.query("INSERT INTO shifts (cashier_id, opened_at) VALUES ($1, '2026-03-06T08:00:00Z')", [user]);
      expect(before).toContain("0012_onec_outbox.sql");
      expect((await migrate(pool))[0]).toBe("0013_reconciliations.sql");

      const kept = await pool.query(
        `SELECT r.id, r.made_by, r.made_at, b.currency, b.calculated_minor::int AS calculated, b.actual_minor::int AS actual, b.difference_minor::int AS difference
           FROM reconciliations r JOIN reconciliation_balances b ON b.reconciliation_id = r.id ORDER BY b.currency`);
      expect(kept.rows).toEqual([
        { id: shift, made_by: user, made_at: new Date("2026-03-05T15:00:00Z"), currency: "RUB", calculated: 140000, actual: 139000, difference: -1000 },
        { id: shift, made_by: user, made_at: new Date("2026-03-05T15:00:00Z"), currency: "USD", calculated: 7000, actual: 7500, difference: 500 },
      ]);
      expect((await pool.query("SELECT count(*)::int AS n FROM reconciliations")).rows[0]).toEqual({ n: 1 });
    } finally {
      await pool.end();
    }
  }, 60_000);
});
