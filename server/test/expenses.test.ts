import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EXPENSE_CATEGORY_CODES } from "../src/categories.js";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const NOW = new Date("2026-03-05T08:30:00Z");

describe("expenses", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Money in the cash desk to start with, as typed by the developer: { RUB: "5000" }. */
  async function cashierApp(opening: { RUB?: string; USD?: string } = {}) {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({
      login: "ivan",
      password: "correct horse",
      role: "cashier",
      displayName: "Иван",
    });
    for (const [currency, amount] of Object.entries(opening)) {
      await started.admin.setOpeningBalance(currency, amount);
    }
    const cookie = await loginAs(started, "ivan", "correct horse");
    app = started;
    return { started, cookie };
  }

  function expense(overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      type: "expense",
      amountMinor: 120_050,
      currency: "RUB",
      category: "fuel_road",
      ...overrides,
    };
  }

  function income(overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      type: "income",
      amountMinor: 500_000,
      currency: "RUB",
      clientCode: "K17",
      ...overrides,
    };
  }

  async function balances(started: TestApp, cookie: string) {
    return (await (await get(started, "/api/balances", cookie)).json()).balances;
  }

  it("saves an expense and answers with it and the new balances", async () => {
    const { started, cookie } = await cashierApp();
    await started.admin.setOpeningBalance("RUB", "10000");
    const body = expense({ recipient: "Азамат", comment: "заправка, рейс 17" });

    const response = await postJson(started, "/api/operations", body, cookie);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      operation: {
        id: body.id,
        type: "expense",
        amountMinor: 120_050,
        currency: "RUB",
        category: "fuel_road",
        recipient: "Азамат",
        clientCode: null,
        comment: "заправка, рейс 17",
        author: { login: "ivan", displayName: "Иван" },
        createdAt: "2026-03-05T08:30:00.000Z",
        revision: 0,
        deletedAt: null,
        deletedBy: null,
      },
      balances: [
        { currency: "RUB", amountMinor: 879_950 },
        { currency: "USD", amountMinor: 0 },
      ],
    });
  });

  it("subtracts expenses from the balance of their own currency only", async () => {
    const { started, cookie } = await cashierApp();
    await started.admin.setOpeningBalance("RUB", "10000");
    await started.admin.setOpeningBalance("USD", "300");

    await postJson(started, "/api/operations", income({ amountMinor: 500_000 }), cookie);
    await postJson(started, "/api/operations", expense({ amountMinor: 120_050 }), cookie);
    await postJson(started, "/api/operations", expense({ amountMinor: 5_000, currency: "USD" }), cookie);

    expect(await balances(started, cookie)).toEqual([
      { currency: "RUB", amountMinor: 1_379_950 },
      { currency: "USD", amountMinor: 25_000 },
    ]);
  });

  describe("the cash desk never pays out more than it holds", () => {
    const refusal = (currency: string, availableMinor: number, requestedMinor: number) => ({
      error: "insufficient_balance",
      currency,
      availableMinor,
      requestedMinor,
    });

    it("refuses an expense above the balance, says how much there is, and saves nothing", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000", USD: "10" });

      const response = await postJson(
        started,
        "/api/operations",
        expense({ currency: "USD", amountMinor: 1_001 }),
        cookie,
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(refusal("USD", 1_000, 1_001));
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 100_000 },
        { currency: "USD", amountMinor: 1_000 },
      ]);
      // A refused expense leaves no trace: had it been saved, dollars would be "the last
      // currency used" (the answer is rubles while this cashier has no operation at all).
      const defaults = await (await get(started, "/api/operations/defaults", cookie)).json();
      expect(defaults).toEqual({ currency: "RUB" });
    });

    it("allows an expense that takes exactly everything, leaving zero", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });

      const response = await postJson(started, "/api/operations", expense({ amountMinor: 100_000 }), cookie);

      expect(response.status).toBe(201);
      expect((await response.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: 0 });
    });

    it("refuses any expense from an empty cash desk", async () => {
      const { started, cookie } = await cashierApp();

      const response = await postJson(started, "/api/operations", expense({ amountMinor: 1 }), cookie);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(refusal("RUB", 0, 1));
    });

    it("counts each currency on its own: dollars cannot cover a ruble expense", async () => {
      const { started, cookie } = await cashierApp({ USD: "1000" });

      const rubles = await postJson(started, "/api/operations", expense({ amountMinor: 100 }), cookie);
      const dollars = await postJson(
        started,
        "/api/operations",
        expense({ amountMinor: 100, currency: "USD" }),
        cookie,
      );

      expect(rubles.status).toBe(422);
      expect(dollars.status).toBe(201);
    });

    it("counts income as it comes in, and refuses again once that money is spent", async () => {
      const { started, cookie } = await cashierApp();
      await postJson(started, "/api/operations", income({ amountMinor: 50_000 }), cookie);

      const first = await postJson(started, "/api/operations", expense({ amountMinor: 30_000 }), cookie);
      const second = await postJson(started, "/api/operations", expense({ amountMinor: 30_000 }), cookie);

      expect(first.status).toBe(201);
      expect(second.status).toBe(422);
      expect(await second.json()).toEqual(refusal("RUB", 20_000, 30_000));
    });

    it.each(EXPENSE_CATEGORY_CODES)(
      "applies to a %s expense too",
      async (category) => {
        const { started, cookie } = await cashierApp({ RUB: "10" });
        const clientCode = category === "client_refund" ? { clientCode: "K17" } : {};

        const response = await postJson(
          started,
          "/api/operations",
          expense({ category, amountMinor: 1_001, ...clientCode }),
          cookie,
        );

        expect(response.status).toBe(422);
      },
    );

    it("looks at the shape of the request first: a malformed expense is a 400, not a 422", async () => {
      const { started, cookie } = await cashierApp();

      const response = await postJson(
        started,
        "/api/operations",
        expense({ category: "client_refund" }),
        cookie,
      );

      expect(response.status).toBe(400);
    });

    it("answers a retry of an accepted expense as before, even though the money is gone now", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });
      const body = expense({ amountMinor: 100_000 });

      const first = await postJson(started, "/api/operations", body, cookie);
      const again = await postJson(started, "/api/operations", body, cookie);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect((await again.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: 0 });
    });

    it("keeps reporting an id clash as a clash, not as a shortage of money", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });
      const body = expense({ amountMinor: 100_000 });
      await postJson(started, "/api/operations", body, cookie);

      const response = await postJson(started, "/api/operations", { ...body, amountMinor: 900_000 }, cookie);

      expect(response.status).toBe(409);
    });

    it("lets the same id be tried again after a refusal, once there is enough money", async () => {
      const { started, cookie } = await cashierApp({ RUB: "100" });
      const body = expense({ amountMinor: 15_000 });

      const refused = await postJson(started, "/api/operations", body, cookie);
      await postJson(started, "/api/operations", income({ amountMinor: 10_000 }), cookie);
      const retried = await postJson(started, "/api/operations", body, cookie);

      expect(refused.status).toBe(422);
      expect(retried.status).toBe(201);
      expect((await retried.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: 5_000 });
    });

    it("cannot be beaten by two cashiers spending the same money at the same moment", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });
      await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier" });
      const petr = await loginAs(started, "petr", "another good one");

      // Six requests of 400 against 1000: however they interleave, two fit and four do not.
      const answers = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          postJson(started, "/api/operations", expense({ amountMinor: 40_000 }), index % 2 === 0 ? cookie : petr),
        ),
      );

      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([201, 201, 422, 422, 422, 422]);
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 20_000 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("lets the same expense be sent twice at the same moment and counts it once", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });
      const body = expense({ amountMinor: 60_000 });

      const answers = await Promise.all(
        Array.from({ length: 4 }, () => postJson(started, "/api/operations", body, cookie)),
      );

      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 200, 201]);
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 40_000 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });
  });

  describe("categories", () => {
    it("lists the six fixed categories with their labels, to any logged-in user", async () => {
      const { started, cookie } = await cashierApp();

      const response = await get(started, "/api/categories", cookie);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        categories: [
          { code: "fuel_road", label: "Топливо и дорога" },
          { code: "salaries", label: "Зарплаты и выплаты" },
          { code: "household_repair", label: "Хозяйство и ремонт" },
          { code: "owner_handover", label: "Передача владельцу" },
          { code: "client_refund", label: "Возврат клиенту" },
          { code: "other", label: "Прочее" },
        ],
      });
      expect((await get(started, "/api/categories")).status).toBe(401);
    });

    it.each([
      "fuel_road",
      "salaries",
      "household_repair",
      "owner_handover",
      "other",
    ])("accepts %s without a client code", async (category) => {
      const { started, cookie } = await cashierApp({ RUB: "5000" });

      const response = await postJson(started, "/api/operations", expense({ category }), cookie);

      expect(response.status).toBe(201);
      expect((await response.json()).operation).toMatchObject({ category, clientCode: null });
    });

    it("keeps a handover to the owner recognisable in the data, apart from ordinary expenses", async () => {
      const { started, cookie } = await cashierApp({ RUB: "5000" });

      const handover = await postJson(
        started,
        "/api/operations",
        expense({ category: "owner_handover", amountMinor: 300_000 }),
        cookie,
      );
      const fuel = await postJson(started, "/api/operations", expense({ category: "fuel_road" }), cookie);

      expect((await handover.json()).operation.category).toBe("owner_handover");
      expect((await fuel.json()).operation.category).toBe("fuel_road");
    });
  });

  describe("client refunds", () => {
    it("records a refund with the client it goes back to, and suggests that code later", async () => {
      const { started, cookie } = await cashierApp({ RUB: "1000" });

      const response = await postJson(
        started,
        "/api/operations",
        expense({ category: "client_refund", clientCode: "  K99 ", amountMinor: 25_000 }),
        cookie,
      );
      const suggestions = await (await get(started, "/api/client-codes?prefix=k9", cookie)).json();

      expect(response.status).toBe(201);
      expect((await response.json()).operation).toMatchObject({
        type: "expense",
        category: "client_refund",
        clientCode: "K99",
      });
      expect(suggestions).toEqual({ codes: ["K99"] });
    });
  });

  describe("rejects bad input and saves nothing", () => {
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ["a missing category", { category: undefined }],
      ["an unknown category", { category: "bribes" }],
      ["a category in another letter case", { category: "Fuel_Road" }],
      ["a zero amount", { amountMinor: 0 }],
      ["a negative amount", { amountMinor: -500 }],
      ["an amount with a fraction of a minor unit", { amountMinor: 10.5 }],
      ["an amount above the limit", { amountMinor: 10_000_000_001 }],
      ["an unknown currency", { currency: "EUR" }],
      ["a recipient that is too long", { recipient: "x".repeat(101) }],
      ["a comment that is too long", { comment: "x".repeat(501) }],
      ["a client code on an ordinary expense", { clientCode: "K17" }],
      ["a refund without a client code", { category: "client_refund" }],
      ["a refund with a blank client code", { category: "client_refund", clientCode: "   " }],
      ["a refund with an empty client code", { category: "client_refund", clientCode: "" }],
      ["an unknown field", { surprise: true }],
      ["a comment with a NUL character", { comment: "a\u0000b" }],
      ["a recipient with a NUL character", { recipient: "a\u0000b" }],
    ];

    it.each(badBodies)("%s", async (_name, overrides) => {
      const { started, cookie } = await cashierApp();

      const response = await postJson(started, "/api/operations", expense(overrides), cookie);

      expect(response.status).toBe(400);
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 0 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("an income that carries a category or a recipient", async () => {
      const { started, cookie } = await cashierApp();

      const withCategory = await postJson(started, "/api/operations", income({ category: "other" }), cookie);
      const withRecipient = await postJson(started, "/api/operations", income({ recipient: "Азамат" }), cookie);

      expect(withCategory.status).toBe(400);
      expect(withRecipient.status).toBe(400);
    });
  });

  it("trims the recipient and treats a blank one as none", async () => {
    const { started, cookie } = await cashierApp({ RUB: "5000" });

    const trimmed = await postJson(started, "/api/operations", expense({ recipient: "  Азамат " }), cookie);
    const blank = await postJson(started, "/api/operations", expense({ recipient: "   " }), cookie);

    expect((await trimmed.json()).operation.recipient).toBe("Азамат");
    expect((await blank.json()).operation.recipient).toBeNull();
  });

  describe("sending the same expense again", () => {
    it("answers with the stored expense and counts it once", async () => {
      const { started, cookie } = await cashierApp({ RUB: "5000" });
      const body = expense({ recipient: "Азамат" });

      const first = await postJson(started, "/api/operations", body, cookie);
      started.setNow(new Date(NOW.getTime() + 60_000));
      const again = await postJson(started, "/api/operations", body, cookie);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect((await again.json()).operation).toEqual((await first.json()).operation);
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 379_950 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it.each<[string, Record<string, unknown>]>([
      ["another category", { category: "salaries" }],
      ["another recipient", { recipient: "Бахтиёр" }],
      ["another amount", { amountMinor: 1 }],
      ["an income with the same id", { type: "income", category: undefined, recipient: undefined, clientCode: "K17" }],
    ])("refuses the same id with %s", async (_name, changes) => {
      const { started, cookie } = await cashierApp({ RUB: "5000" });
      const body = expense({ recipient: "Азамат" });
      await postJson(started, "/api/operations", body, cookie);

      const response = await postJson(started, "/api/operations", { ...body, ...changes }, cookie);

      expect(response.status).toBe(409);
      expect(await balances(started, cookie)).toEqual([
        { currency: "RUB", amountMinor: 379_950 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });
  });

  describe("who may record expenses", () => {
    it("refuses a viewer, before even looking at the body", async () => {
      const { started } = await cashierApp();
      await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer" });
      const owner = await loginAs(started, "owner", "long enough pass");

      const valid = await postJson(started, "/api/operations", expense(), owner);
      const nonsense = await postJson(started, "/api/operations", { nonsense: true }, owner);

      expect(valid.status).toBe(403);
      expect(nonsense.status).toBe(403);
      expect(await balances(started, owner)).toEqual([
        { currency: "RUB", amountMinor: 0 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("refuses a request without a login", async () => {
      app = await startTestApp();

      const response = await postJson(app, "/api/operations", expense());

      expect(response.status).toBe(401);
    });
  });

  it("makes the currency of an expense the default for the next entry", async () => {
    const { started, cookie } = await cashierApp({ USD: "5000" });
    await postJson(started, "/api/operations", expense({ currency: "USD" }), cookie);

    const response = await get(started, "/api/operations/defaults", cookie);

    expect(await response.json()).toEqual({ currency: "USD" });
  });
});
