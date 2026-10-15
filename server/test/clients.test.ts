import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

type Entry = Record<string, unknown>;

/** The directory of clients: one client to a code, looked up by the entry forms, kept by the admin. */
describe("the clients", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "anvar", password: "admin pass word", role: "head_cashier", displayName: "Анвар" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      mudir: await loginAs(started, "mudir", "admin password"),
      anvar: await loginAs(started, "anvar", "admin pass word"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const load = (started: TestApp, cookie: string, clients: Entry[]) => postJson(started, "/api/admin/clients/import", { clients }, cookie);
  const search = async (started: TestApp, cookie: string, q = "") =>
    ((await (await get(started, `/api/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`, cookie)).json()).clients as Array<{ code: string; name: string }>).map(
      (client) => `${client.code} ${client.name}`.trim(),
    );
  const payment = (clientCode: string, overrides: Entry = {}): Entry =>
    withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", category: "client_payment", clientCode, ...overrides });

  it("loads a list, the codes written one way whatever was typed, and leaves the codes already there as they are", async () => {
    const { started, mudir } = await desk();
    const first = await load(started, mudir, [
      { code: "А707", name: "Карим" },
      { code: "a70", name: "Самад", phone: "7 999 000 00 00" },
      { code: "А-45" },
      { code: "А34-2", name: "Эркин" },
    ]);
    expect(await first.json()).toEqual({ added: 4, skipped: 0 });
    const again = await load(started, mudir, [{ code: "А707", name: "Другой" }, { code: "А7", name: "Новый" }]);
    expect(await again.json()).toEqual({ added: 1, skipped: 1 });
    expect(await search(started, mudir)).toEqual(["А7 Новый", "А34-2 Эркин", "А45", "А70 Самад", "А707 Карим"]);
  });

  it("refuses a list with a code twice, saying which, and loads nothing of it", async () => {
    const { started, mudir } = await desk();
    const refused = await load(started, mudir, [{ code: "А400", name: "Сабир" }, { code: "А1", name: "Один" }, { code: "а400", name: "Ёкуб" }]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "repeated_codes", codes: [{ code: "А400", lines: [1, 3] }] });
    expect(await search(started, mudir)).toEqual([]);
  });

  it("finds clients by the beginning of the code first, then by a part of the name", async () => {
    const { started, ivan, mudir } = await desk();
    await load(started, mudir, [{ code: "А707", name: "Карим" }, { code: "А70", name: "Самад" }, { code: "А170", name: "Зариф" }, { code: "А2", name: "Самад ака" }]);
    expect(await search(started, ivan, "а70")).toEqual(["А70 Самад", "А707 Карим"]);
    expect(await search(started, ivan, "самад")).toEqual(["А2 Самад ака", "А70 Самад"]);
  });

  it("lets the admin alone add a client, one to a code, change it and switch it off", async () => {
    const { started, mudir, anvar, ivan, owner } = await desk();
    expect((await postJson(started, "/api/admin/clients", { code: "А900", name: "Вали" }, mudir)).status).toBe(201);
    expect((await postJson(started, "/api/admin/clients", { code: "А902" }, anvar)).status).toBe(403);
    expect(await (await postJson(started, "/api/admin/clients", { code: "a900", name: "Другой" }, mudir)).json()).toEqual({ error: "client_exists" });
    expect((await postJson(started, "/api/admin/clients", { code: "Б12" }, mudir)).status).toBe(400);
    expect((await postJson(started, "/api/admin/clients", { code: "А901" }, ivan)).status).toBe(403);
    expect((await postJson(started, "/api/admin/clients", { code: "А901" }, owner)).status).toBe(403);

    expect((await patchJson(started, "/api/admin/clients/А900", { phone: "7 900", active: false }, anvar)).status).toBe(403);
    const changed = await patchJson(started, `/api/admin/clients/${encodeURIComponent("А900")}`, { name: "Вали ака", phone: "7 900", active: false }, mudir);
    expect(await changed.json()).toEqual({ client: { code: "А900", name: "Вали ака", phone: "7 900", note: null, active: false } });
    expect(await search(started, ivan, "А900")).toEqual([]);
  });

  it("takes a payment only of a client of the directory, and writes the client the way the directory names them", async () => {
    const { started, ivan, mudir } = await desk();
    // While the directory is empty, any code is taken as typed: loading it is no condition for working.
    expect((await postJson(started, "/api/operations", payment("A1 кто-то"), ivan)).status).toBe(201);
    await load(started, mudir, [{ code: "А707", name: "Карим" }]);

    const saved = await postJson(started, "/api/operations", payment("a707"), ivan);
    expect(saved.status).toBe(201);
    expect((await saved.json()).operation.clientCode).toBe("А707 Карим");
    const unknown = await postJson(started, "/api/operations", payment("А708"), ivan);
    expect([unknown.status, (await unknown.json()).error]).toEqual([400, "unknown_client"]);
  });

  it("lets a correction keep a client that is not in the directory, but not put one in", async () => {
    const { started, ivan, mudir } = await desk();
    const old = payment("А5 Старый");
    await postJson(started, "/api/operations", old, ivan);
    await load(started, mudir, [{ code: "А707", name: "Карим" }]);
    const correct = (body: Entry) => putJson(started, `/api/operations/${old.id}`, { ...old, id: undefined, ...body }, ivan);

    expect((await correct({ amountMinor: 60_000 })).status).toBe(200);
    expect((await correct({ clientCode: "А6" })).status).toBe(400);
    expect((await (await correct({ clientCode: "а707" })).json()).operation.clientCode).toBe("А707 Карим");
  });
});
