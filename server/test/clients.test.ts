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
      { code: "А-45", name: "Вали" },
      { code: "А34-2", name: "Эркин" },
    ]);
    expect(await first.json()).toEqual({ added: 4, skipped: 0 });
    const again = await load(started, mudir, [{ code: "А707", name: "Другой" }, { code: "А7", name: "Новый" }]);
    expect(await again.json()).toEqual({ added: 1, skipped: 1 });
    expect(await search(started, mudir)).toEqual(["А7 Новый", "А34-2 Эркин", "А45 Вали", "А70 Самад", "А707 Карим"]);
  });

  it("takes no client without a name: not in a list, which is then not loaded at all, not in the form, not by a change", async () => {
    const { started, mudir } = await desk();
    // A client is a code and a name, both. A list with a nameless line says which lines, and nothing of it is loaded.
    const refused = await load(started, mudir, [{ code: "А707", name: "Карим" }, { code: "А413" }, { code: "А584", name: "  " }]);
    expect([refused.status, await refused.json()]).toEqual([400, { error: "nameless", rows: [{ line: 2, code: "А413" }, { line: 3, code: "А584" }] }]);
    expect(await search(started, mudir)).toEqual([]);
    for (const body of [{ code: "А413" }, { code: "А413", name: "" }, { code: "А413", name: "   " }]) {
      const answer = await postJson(started, "/api/admin/clients", body, mudir);
      expect([answer.status, ((await answer.json()) as { error: string }).error], JSON.stringify(body)).toEqual([400, "bad_name"]);
    }
    expect((await postJson(started, "/api/admin/clients", { name: "Ахмад" }, mudir)).status).toBe(400);
    expect((await postJson(started, "/api/admin/clients", { code: "А413", name: "Ахмад" }, mudir)).status).toBe(201);
    // The name may be changed and never taken away.
    const emptied = await patchJson(started, `/api/admin/clients/${encodeURIComponent("А413")}`, { name: " " }, mudir);
    expect([emptied.status, ((await emptied.json()) as { error: string }).error]).toEqual([400, "bad_name"]);
    expect(await search(started, mudir)).toEqual(["А413 Ахмад"]);
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
    // The letter may be left out: "70" is А70 and what starts so.
    expect(await search(started, ivan, "70")).toEqual(["А70 Самад", "А707 Карим"]);
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
    const digits = await postJson(started, "/api/operations", payment("707"), ivan);
    expect((await digits.json()).operation.clientCode).toBe("А707 Карим");
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

  /** A business whose clients have digits for codes (CLIENT_CODES=digits). */
  describe("where the codes are digits alone", () => {
    async function digitsDesk() {
      const started = await startTestApp({ clientCodes: "digits" });
      app = started;
      await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
      await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
      return { started, mudir: await loginAs(started, "mudir", "admin password"), ivan: await loginAs(started, "ivan", "correct horse") };
    }

    it("loads a list of such codes as they are, without a letter, and says so to the screen", async () => {
      const { started, mudir } = await digitsDesk();
      // One digit is a code too (the client 3).
      const loaded = await load(started, mudir, [{ code: "707", name: "Карим" }, { code: " 70 ", name: "Самад" }, { code: "34-2", name: "Эркин" }, { code: "123456", name: "Зариф" }, { code: "3", name: "Рахимберди" }]);
      expect(await loaded.json()).toEqual({ added: 5, skipped: 0 });
      expect(await search(started, mudir)).toEqual(["3 Рахимберди", "34-2 Эркин", "70 Самад", "707 Карим", "123456 Зариф"]);
      expect(await search(started, mudir, "70")).toEqual(["70 Самад", "707 Карим"]);
      expect((await (await get(started, "/api/clients", mudir)).json()).codes).toBe("digits");
    });

    it("refuses a code with a letter, in a list and in the form of a client", async () => {
      const { started, mudir } = await digitsDesk();
      const loaded = await load(started, mudir, [{ code: "707", name: "Карим" }, { code: "А708", name: "Самад" }]);
      expect([loaded.status, await loaded.json()]).toEqual([400, { error: "bad_codes", rows: [{ line: 2, code: "А708" }] }]);
      const typed = await postJson(started, "/api/admin/clients", { code: "А708", name: "Кто-то" }, mudir);
      expect([typed.status, (await typed.json()).error]).toEqual([400, "bad_code"]);
      const withName = await postJson(started, "/api/admin/clients", { code: "708 Кто-то" }, mudir);
      expect((await withName.json()).error).toBe("bad_code");
      const made = await postJson(started, "/api/admin/clients", { code: "708", name: "Кто-то" }, mudir);
      expect([made.status, (await made.json()).client.code]).toEqual([201, "708"]);
      const changed = await patchJson(started, "/api/admin/clients/708", { name: "Карим" }, mudir);
      expect((await changed.json()).client).toMatchObject({ code: "708", name: "Карим" });
    });

    it("takes a payment of a client of the directory by the digits typed, and writes no letter", async () => {
      const { started, mudir, ivan } = await digitsDesk();
      await load(started, mudir, [{ code: "707", name: "Карим" }]);
      const saved = await postJson(started, "/api/operations", payment("707"), ivan);
      expect([saved.status, (await saved.json()).operation.clientCode]).toEqual([201, "707 Карим"]);
      const picked = await postJson(started, "/api/operations", payment("707 Карим"), ivan);
      expect((await picked.json()).operation.clientCode).toBe("707 Карим");
      const lettered = await postJson(started, "/api/operations", payment("А707"), ivan);
      expect([lettered.status, (await lettered.json()).error]).toEqual([400, "unknown_client"]);
    });
  });

  it("says that the codes have the letter unless the settings say otherwise", async () => {
    const { started, ivan } = await desk();
    expect((await (await get(started, "/api/clients", ivan)).json()).codes).toBe("letter");
  });
});
