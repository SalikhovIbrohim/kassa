import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

/** The guest is shown the cash desk: he reads what the owner reads, and nothing he sends changes anything. */
describe("the guest role", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "guest", password: "only looking 1", role: "guest", displayName: "Гость" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const ivan = await loginAs(started, "ivan", "correct horse");
    expect((await postJson(started, "/api/admin/clients", { code: "А17", name: "Тимур", phone: "+998 90 000 00 00", note: "склад" }, mudir)).status).toBe(201);
    const entry = withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "А17 Тимур" });
    expect((await postJson(started, "/api/operations", entry, ivan)).status).toBe(201);
    return { started, mudir, ivan, guest: await loginAs(started, "guest", "only looking 1"), entry };
  }

  it("reads the journal, the totals, the counts, the balances and the lists of the forms", async () => {
    const { started, guest, entry } = await desk();
    expect(await (await get(started, "/api/me", guest)).json()).toMatchObject({ user: { login: "guest", role: "guest" } });
    for (const path of ["/api/operations", "/api/summary", "/api/reconciliations", "/api/balances", "/api/categories", "/api/cashiers", `/api/operations/${entry.id}/history`]) {
      expect((await get(started, path, guest)).status, path).toBe(200);
    }
    // The admin's column «1С» is not his.
    const journal = (await (await get(started, "/api/operations", guest)).json()).operations as Array<Record<string, unknown>>;
    expect(journal).toHaveLength(1);
    expect("onec" in journal[0]!).toBe(false);
    expect((await get(started, "/api/operations?onec=problem", guest)).status).toBe(403);
  });

  it("changes nothing: every route that writes refuses him", async () => {
    const { started, guest, entry } = await desk();
    const before = JSON.stringify(await started.query("SELECT * FROM operations ORDER BY id"));
    const users = (await started.query<{ id: string }>("SELECT id FROM users ORDER BY login"))[0]!.id;

    const tries: Array<[string, Promise<Response>]> = [
      ["enter", postJson(started, "/api/operations", withRate({ id: randomUUID(), type: "income", amountMinor: 100, currency: "RUB", clientCode: "А17" }), guest)],
      ["expense", postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 100, currency: "USD", category: "fuel_road" }, guest)],
      ["correct", putJson(started, `/api/operations/${entry.id}`, { type: "income", amountMinor: 1, currency: "RUB", rateE4: 790_000, clientCode: "А17", reason: "x" }, guest)],
      ["delete", deleteRequest(started, `/api/operations/${entry.id}`, guest, { reason: "x" })],
      ["count", postJson(started, "/api/reconciliations", { id: randomUUID(), counts: [{ currency: "RUB", amountMinor: 0 }, { currency: "USD", amountMinor: 0 }] }, guest)],
      ["category", postJson(started, "/api/admin/categories", { kind: "expense", label: "Новая" }, guest)],
      ["category change", patchJson(started, "/api/admin/categories/fuel_road", { label: "Новая" }, guest)],
      ["client", postJson(started, "/api/admin/clients", { code: "А18", name: "Новый" }, guest)],
      ["client change", patchJson(started, "/api/admin/clients/А17", { name: "Другой" }, guest)],
      ["user", postJson(started, "/api/admin/users", { login: "x1", password: "long enough pass", role: "admin", displayName: "X" }, guest)],
      ["user change", patchJson(started, `/api/admin/users/${users}`, { role: "admin" }, guest)],
      ["users", get(started, "/api/admin/users", guest)],
      ["1c retry", postJson(started, "/api/admin/onec/1/retry", {}, guest)],
      ["1c skip", postJson(started, "/api/admin/onec/1/skip", {}, guest)],
    ];
    for (const [what, sent] of tries) expect((await sent).status, what).toBe(403);

    expect(JSON.stringify(await started.query("SELECT * FROM operations ORDER BY id"))).toBe(before);
    expect(await started.query("SELECT count(*)::int AS n FROM users")).toEqual([{ n: 3 }]);
    expect(await started.query("SELECT count(*)::int AS n FROM clients")).toEqual([{ n: 1 }]);
  });

  it("gets a few names for what he typed in the form, never the directory of clients, the phones or the notes", async () => {
    const { started, guest, ivan } = await desk();
    expect((await (await get(started, "/api/clients", guest)).json()).clients).toEqual([]);
    expect((await (await get(started, "/api/clients?all=1", guest)).json()).clients).toEqual([]);
    const found = (await (await get(started, "/api/clients?q=17&limit=5000", guest)).json()).clients;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "А17", name: "Тимур", phone: null, note: null });
    // A cashier still gets them.
    expect((await (await get(started, "/api/clients?q=17", ivan)).json()).clients[0]).toMatchObject({ phone: "+998 90 000 00 00" });
  });
});
