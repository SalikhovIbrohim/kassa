import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Entry = Record<string, unknown>;
type Category = { code: string; kind: string; label: string; sortOrder: number; archived: boolean; requiresClient: boolean };

/** The lists of categories of incomes and expenses, which the owner keeps, and what an entry may say about them. */
describe("categories", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 79_000, currency: "RUB", rateE4: 790_000, category: "client_payment", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });

  async function post(started: TestApp, cookie: string, body: Entry) {
    const response = await postJson(started, "/api/operations", body, cookie);
    return { status: response.status, body: await response.json() };
  }

  async function lists(started: TestApp, cookie: string) {
    return (await (await get(started, "/api/categories", cookie)).json()) as { categories: Category[]; income: Category[]; all: Category[] };
  }

  const make = (started: TestApp, owner: string, body: Entry) => postJson(started, "/api/admin/categories", body, owner);

  describe("what an entry may say", () => {
    it("takes an income of a category that names no client, without a client code", async () => {
      const { started, ivan } = await desk();

      const answer = await post(started, ivan, income({ category: "debt_taken", clientCode: undefined }));

      expect(answer.status).toBe(201);
      expect(answer.body.operation).toMatchObject({ type: "income", category: "debt_taken", clientCode: null });
    });

    it("asks a client code of the category that names a client, and refuses one for a category that does not", async () => {
      const { started, ivan } = await desk();

      expect((await post(started, ivan, income({ clientCode: undefined }))).status).toBe(400);
      expect((await post(started, ivan, income({ clientCode: "  " }))).status).toBe(400);
      expect((await post(started, ivan, income({ category: "sublease", clientCode: "K17" }))).status).toBe(400);
      expect((await post(started, ivan, expense({ clientCode: "K17" }))).status).toBe(400);
      expect((await post(started, ivan, expense({ category: "client_refund" }))).status).toBe(400);
    });

    it("takes an income of an older phone, which names no category, for a payment of a client", async () => {
      const { started, ivan } = await desk();
      const { category: _category, ...older } = income();

      const answer = await post(started, ivan, older);

      expect(answer.status).toBe(201);
      expect(answer.body.operation).toMatchObject({ category: "client_payment", clientCode: "K17" });
    });

    it("keeps the kinds apart, and knows only the categories that exist", async () => {
      const { started, ivan } = await desk();

      expect((await post(started, ivan, income({ category: "fuel_road", clientCode: undefined }))).status).toBe(400);
      expect((await post(started, ivan, expense({ category: "debt_taken" }))).status).toBe(400);
      expect((await post(started, ivan, expense({ category: "nonsense" }))).status).toBe(400);
      expect((await post(started, ivan, income({ category: "Client_Payment" }))).status).toBe(400);
    });

    it("keeps the category of an income in the history when it is changed", async () => {
      const { started, ivan, owner } = await desk();
      const body = income();
      await post(started, ivan, body);

      const edit = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 79_000, currency: "RUB", rateE4: 790_000, category: "sublease" }, ivan);

      expect(edit.status).toBe(200);
      expect((await edit.json()).operation).toMatchObject({ category: "sublease", clientCode: null });
      const history = await (await get(started, `/api/operations/${body.id}/history`, owner)).json();
      expect(history.changes[0]).toMatchObject({ before: { category: "client_payment", clientCode: "K17" }, after: { category: "sublease", clientCode: null } });
    });
  });

  describe("the owner's lists", () => {
    it("are changed by the owner only", async () => {
      const { started, ivan, owner } = await desk();

      expect((await postJson(started, "/api/admin/categories", { kind: "expense", label: "Новая" }, ivan)).status).toBe(403);
      expect((await postJson(started, "/api/admin/categories", { kind: "expense", label: "Новая" })).status).toBe(401);
      expect((await patchJson(started, "/api/admin/categories/fuel_road", { label: "Новая" }, ivan)).status).toBe(403);
      expect((await make(started, owner, { kind: "expense", label: "Новая" })).status).toBe(201);
    });

    it("get a new category at the end of its own list, and a cashier may use it at once", async () => {
      const { started, ivan, owner } = await desk();

      const created = await make(started, owner, { kind: "expense", label: "  Ремонт склада  " });

      expect(created.status).toBe(201);
      const { category } = await created.json();
      expect(category).toMatchObject({ kind: "expense", label: "Ремонт склада", archived: false, requiresClient: false });
      const { categories, income } = await lists(started, ivan);
      expect(categories.at(-1)!.code).toBe(category.code);
      expect(income.some((item) => item.code === category.code)).toBe(false);
      const used = await post(started, ivan, expense({ category: category.code }));
      expect(used.status).toBe(201);
      expect(used.body.operation.category).toBe(category.code);
    });

    it("do not take the same label twice in one list, in whatever letter case, but may in the other", async () => {
      const { started, owner } = await desk();

      expect((await make(started, owner, { kind: "expense", label: "обед склад" })).status).toBe(409);
      expect((await make(started, owner, { kind: "expense", label: "ОБЕД СКЛАД " })).status).toBe(409);
      expect((await make(started, owner, { kind: "income", label: "Обед склад" })).status).toBe(201);
    });

    it("refuse what is not a category", async () => {
      const { started, owner } = await desk();

      for (const body of [{}, { kind: "expense" }, { kind: "debt", label: "X" }, { kind: "expense", label: "   " }, { kind: "expense", label: "x".repeat(61) }, { kind: "expense", label: "X", extra: 1 }]) {
        expect((await make(started, owner, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it("can be renamed, and told whether the category names a client: the next entries follow", async () => {
      const { started, ivan, owner } = await desk();

      const renamed = await patchJson(started, "/api/admin/categories/debt_taken", { label: "Заём", requiresClient: true }, owner);

      expect(renamed.status).toBe(200);
      expect((await renamed.json()).category).toMatchObject({ code: "debt_taken", label: "Заём", requiresClient: true });
      expect((await post(started, ivan, income({ category: "debt_taken", clientCode: undefined }))).status).toBe(400);
      expect((await post(started, ivan, income({ category: "debt_taken", clientCode: "Иван" }))).status).toBe(201);
    });

    it("say 409 for a label that is taken, 404 for a category that is not there, 400 for nothing to change", async () => {
      const { started, owner } = await desk();

      expect((await patchJson(started, "/api/admin/categories/customs", { label: "Оплата фура" }, owner)).status).toBe(409);
      expect((await patchJson(started, "/api/admin/categories/nothing_here", { label: "X" }, owner)).status).toBe(404);
      expect((await patchJson(started, "/api/admin/categories/customs", {}, owner)).status).toBe(400);
      expect((await patchJson(started, "/api/admin/categories/customs", { label: "X", counts_as_cost: false }, owner)).status).toBe(400);
    });

    it("are moved up and down, and the order is what the cashiers see", async () => {
      const { started, ivan, owner } = await desk();
      const first = (await lists(started, ivan)).categories.slice(0, 3).map((item) => item.code);
      expect(first).toEqual(["fuel_road", "salaries", "household_repair"]);

      await patchJson(started, "/api/admin/categories/household_repair", { move: "up" }, owner);
      await patchJson(started, "/api/admin/categories/fuel_road", { move: "down" }, owner);

      expect((await lists(started, ivan)).categories.slice(0, 3).map((item) => item.code)).toEqual(["household_repair", "fuel_road", "salaries"]);
      // The first one cannot go higher, the last cannot go lower: nothing happens, and it is not an error.
      expect((await patchJson(started, "/api/admin/categories/household_repair", { move: "up" }, owner)).status).toBe(200);
      const { categories } = await lists(started, ivan);
      const last = categories.at(-1)!.code;
      expect((await patchJson(started, `/api/admin/categories/${last}`, { move: "down" }, owner)).status).toBe(200);
      expect((await lists(started, ivan)).categories.at(-1)!.code).toBe(last);
    });
  });

  describe("an archived category", () => {
    it("leaves the lists for new entries, stays in the list of every category, and is not taken for a new entry", async () => {
      const { started, ivan, owner } = await desk();

      await patchJson(started, "/api/admin/categories/gazelle", { archived: true }, owner);

      const { categories, all } = await lists(started, ivan);
      expect(categories.some((item) => item.code === "gazelle")).toBe(false);
      expect(all.find((item) => item.code === "gazelle")).toMatchObject({ archived: true });
      expect((await post(started, ivan, expense({ category: "gazelle" }))).status).toBe(400);
    });

    it("does not turn away the retry of an entry that was accepted before, nor a correction that leaves the category alone", async () => {
      const { started, ivan, owner } = await desk();
      const body = expense({ category: "gazelle" });
      await post(started, ivan, body);
      await patchJson(started, "/api/admin/categories/gazelle", { archived: true }, owner);

      const again = await post(started, ivan, body);
      const edit = await putJson(started, `/api/operations/${body.id}`, { type: "expense", amountMinor: 20_000, currency: "RUB", category: "gazelle" }, ivan);
      const elsewhere = await putJson(started, `/api/operations/${body.id}`, { type: "expense", amountMinor: 20_000, currency: "RUB", category: "customs" }, ivan);
      const back = await putJson(started, `/api/operations/${body.id}`, { type: "expense", amountMinor: 20_000, currency: "RUB", category: "gazelle" }, ivan);

      expect(again.status).toBe(200);
      expect(edit.status).toBe(200);
      expect(elsewhere.status).toBe(200);
      // Once it has left for another category, the archived one is no longer the operation's own.
      expect(back.status).toBe(400);
    });

    it("can come back", async () => {
      const { started, ivan, owner } = await desk();
      await patchJson(started, "/api/admin/categories/gazelle", { archived: true }, owner);

      await patchJson(started, "/api/admin/categories/gazelle", { archived: false }, owner);

      expect((await post(started, ivan, expense({ category: "gazelle" }))).status).toBe(201);
    });

    it("never takes the last category of a list out of use", async () => {
      const { started, ivan, owner } = await desk();

      for (const code of ["client_payment", "debt_taken", "sublease", "debt_returned"]) {
        expect((await patchJson(started, `/api/admin/categories/${code}`, { archived: true }, owner)).status).toBe(200);
      }
      const last = await patchJson(started, "/api/admin/categories/other_income", { archived: true }, owner);

      expect(last.status).toBe(409);
      expect(await last.json()).toEqual({ error: "last_category" });
      expect((await lists(started, ivan)).income.map((item) => item.code)).toEqual(["other_income"]);
    });
  });

  describe("in the totals", () => {
    async function totals(started: TestApp, owner: string) {
      const response = await get(started, "/api/summary", owner);
      return (await response.json()).currencies[0] as {
        expenseMinor: number;
        handoverMinor: number;
        expenseByCategory: Array<{ category: string; amountMinor: number }>;
      };
    }

    it("show a new category, count it as a cost, and keep a category of the handover apart", async () => {
      const { started, ivan, owner } = await desk();
      await started.admin.setOpeningBalance("RUB", "1000");
      const { category } = await (await make(started, owner, { kind: "expense", label: "Ремонт склада" })).json();
      await post(started, ivan, expense({ category: category.code, amountMinor: 30_000 }));
      await post(started, ivan, expense({ category: "owner_handover", amountMinor: 20_000 }));

      const rub = await totals(started, owner);

      expect(rub.expenseByCategory.find((item) => item.category === category.code)).toEqual({ category: category.code, amountMinor: 30_000 });
      expect(rub.expenseByCategory.some((item) => item.category === "owner_handover")).toBe(false);
      expect(rub).toMatchObject({ expenseMinor: 30_000, handoverMinor: 20_000 });
    });

    it("keep an archived category only while it has something in the period", async () => {
      const { started, ivan, owner } = await desk();
      await post(started, ivan, expense({ category: "gazelle", amountMinor: 5_000 }));
      await patchJson(started, "/api/admin/categories/gazelle", { archived: true }, owner);
      await patchJson(started, "/api/admin/categories/customs", { archived: true }, owner);

      const rub = await totals(started, owner);

      expect(rub.expenseByCategory.find((item) => item.category === "gazelle")).toEqual({ category: "gazelle", amountMinor: 5_000 });
      expect(rub.expenseByCategory.some((item) => item.category === "customs")).toBe(false);
    });
  });
});
