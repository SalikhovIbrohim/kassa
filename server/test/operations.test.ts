import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

const NOW = new Date("2026-03-05T08:30:00Z");

describe("income and balances", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function cashierApp() {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({
      login: "ivan",
      password: "correct horse",
      role: "cashier",
      displayName: "Иван",
    });
    const cookie = await loginAs(started, "ivan", "correct horse");
    app = started;
    return { started, cookie };
  }

  function income(overrides: Record<string, unknown> = {}) {
    return withRate({
      id: randomUUID(),
      type: "income",
      amountMinor: 150_000,
      currency: "RUB",
      clientCode: "K17",
      ...overrides,
    });
  }

  it("saves an income and answers with it and the new balances", async () => {
    const { started, cookie } = await cashierApp();
    const body = income({ comment: "за рейс в Ташкент" });

    const response = await postJson(started, "/api/operations", body, cookie);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      operation: {
        id: body.id,
        type: "income",
        amountMinor: 150_000,
        currency: "RUB",
        rateE4: 790_000,
        usdMinor: 1_899,
        rateSource: "own",
        category: "client_payment",
        recipient: null,
        clientCode: "K17",
        comment: "за рейс в Ташкент",
        author: { login: "ivan", displayName: "Иван" },
        createdAt: "2026-03-05T08:30:00.000Z",
        shiftId: null,
        revision: 0,
        deletedAt: null,
        deletedBy: null,
      },
      balances: [
        { currency: "RUB", amountMinor: 150_000 },
        { currency: "USD", amountMinor: 0 },
      ],
    });
  });

  it("keeps every currency's balance separate", async () => {
    const { started, cookie } = await cashierApp();

    await postJson(started, "/api/operations", income({ amountMinor: 150_000 }), cookie);
    await postJson(started, "/api/operations", income({ amountMinor: 10_000, currency: "USD" }), cookie);
    await postJson(started, "/api/operations", income({ amountMinor: 2_550 }), cookie);
    const response = await get(started, "/api/balances", cookie);

    expect(await response.json()).toEqual({
      balances: [
        { currency: "RUB", amountMinor: 152_550 },
        { currency: "USD", amountMinor: 10_000 },
      ],
    });
  });

  it("starts each balance from the opening balance the developer set", async () => {
    const { started, cookie } = await cashierApp();
    await started.admin.setOpeningBalance("RUB", "1000.50");
    await started.admin.setOpeningBalance("USD", "20");

    const before = await (await get(started, "/api/balances", cookie)).json();
    await postJson(started, "/api/operations", income({ amountMinor: 50_000 }), cookie);
    const after = await (await get(started, "/api/balances", cookie)).json();

    expect(before).toEqual({
      balances: [
        { currency: "RUB", amountMinor: 100_050 },
        { currency: "USD", amountMinor: 2_000 },
      ],
    });
    expect(after).toEqual({
      balances: [
        { currency: "RUB", amountMinor: 150_050 },
        { currency: "USD", amountMinor: 2_000 },
      ],
    });
  });

  describe("rejects bad input and saves nothing", () => {
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ["a zero amount", { amountMinor: 0 }],
      ["a negative amount", { amountMinor: -500 }],
      ["an amount with a fraction of a minor unit", { amountMinor: 1500.5 }],
      ["an amount given as text", { amountMinor: "1500" }],
      ["an amount above the limit", { amountMinor: 10_000_000_001 }],
      ["an unknown currency", { currency: "EUR" }],
      ["a lower-case currency", { currency: "rub" }],
      ["a missing client code", { clientCode: undefined }],
      ["a blank client code", { clientCode: "   " }],
      ["a client code that is too long", { clientCode: "K".repeat(65) }],
      ["a comment that is too long", { comment: "x".repeat(501) }],
      ["an unsupported operation type", { type: "expense" }],
      ["an id that is not a uuid", { id: "12345" }],
      ["an unknown field", { surprise: true }],
      ["a client code with a NUL character", { clientCode: "K\u00001" }],
      ["a comment with a NUL character", { comment: "a\u0000b" }],
    ];

    it.each(badBodies)("%s", async (_name, overrides) => {
      const { started, cookie } = await cashierApp();

      const response = await postJson(started, "/api/operations", income(overrides), cookie);
      const balances = await (await get(started, "/api/balances", cookie)).json();

      expect(response.status).toBe(400);
      expect(balances).toEqual({
        balances: [
          { currency: "RUB", amountMinor: 0 },
          { currency: "USD", amountMinor: 0 },
        ],
      });
    });
  });

  it("accepts the largest allowed amount", async () => {
    const { started, cookie } = await cashierApp();

    const response = await postJson(
      started,
      "/api/operations",
      income({ amountMinor: 10_000_000_000 }),
      cookie,
    );

    expect(response.status).toBe(201);
  });

  it("trims the client code and the comment, and treats a blank comment as none", async () => {
    const { started, cookie } = await cashierApp();

    const trimmed = await postJson(
      started,
      "/api/operations",
      income({ clientCode: "  K17 ", comment: "  привет  " }),
      cookie,
    );
    const blank = await postJson(started, "/api/operations", income({ comment: "   " }), cookie);

    expect((await trimmed.json()).operation).toMatchObject({ clientCode: "K17", comment: "привет" });
    expect((await blank.json()).operation.comment).toBeNull();
  });

  describe("sending the same operation again", () => {
    it("answers with the stored operation and counts it once", async () => {
      const { started, cookie } = await cashierApp();
      const body = income({ amountMinor: 150_000, comment: "за рейс" });

      const first = await postJson(started, "/api/operations", body, cookie);
      started.setNow(new Date(NOW.getTime() + 60 * 60 * 1000));
      const again = await postJson(started, "/api/operations", body, cookie);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      const firstBody = await first.json();
      const againBody = await again.json();
      expect(againBody.operation).toEqual(firstBody.operation);
      expect(againBody.operation.createdAt).toBe("2026-03-05T08:30:00.000Z");
      expect(againBody.balances).toEqual([
        { currency: "RUB", amountMinor: 150_000 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("refuses the same id with different content and changes nothing", async () => {
      const { started, cookie } = await cashierApp();
      const body = income({ amountMinor: 150_000 });
      await postJson(started, "/api/operations", body, cookie);

      const conflicting = await postJson(
        started,
        "/api/operations",
        { ...body, amountMinor: 999_999 },
        cookie,
      );
      const balances = await (await get(started, "/api/balances", cookie)).json();

      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toEqual({ error: "operation_id_conflict" });
      expect(balances.balances[0]).toEqual({ currency: "RUB", amountMinor: 150_000 });
    });

    it("refuses an id that another cashier already used, without revealing it", async () => {
      const { started, cookie } = await cashierApp();
      await started.admin.createUser({ login: "petr", password: "battery staple", role: "cashier" });
      const petr = await loginAs(started, "petr", "battery staple");
      const body = income({ amountMinor: 150_000 });
      await postJson(started, "/api/operations", body, cookie);

      const response = await postJson(started, "/api/operations", body, petr);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "operation_id_conflict" });
    });

    it("counts once even when the same operation arrives twice at the same moment", async () => {
      const { started, cookie } = await cashierApp();
      const body = income({ amountMinor: 70_000 });

      const responses = await Promise.all([
        postJson(started, "/api/operations", body, cookie),
        postJson(started, "/api/operations", body, cookie),
        postJson(started, "/api/operations", body, cookie),
      ]);
      const balances = await (await get(started, "/api/balances", cookie)).json();

      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(balances.balances[0]).toEqual({ currency: "RUB", amountMinor: 70_000 });
    });
  });

  describe("who may do what", () => {
    it("lets a viewer read balances but not record anything", async () => {
      const { started, cookie } = await cashierApp();
      await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer" });
      const owner = await loginAs(started, "owner", "long enough pass");
      await postJson(started, "/api/operations", income({ amountMinor: 150_000 }), cookie);

      const attempt = await postJson(started, "/api/operations", income({ amountMinor: 999 }), owner);
      const balances = await get(started, "/api/balances", owner);

      expect(attempt.status).toBe(403);
      expect(await attempt.json()).toEqual({ error: "forbidden" });
      expect(balances.status).toBe(200);
      expect((await balances.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: 150_000 });
    });

    it("turns away people who are not logged in", async () => {
      app = await startTestApp();

      const post = await postJson(app, "/api/operations", income());
      const nonsense = await postJson(app, "/api/operations", { nonsense: true });
      const read = await get(app, "/api/balances");

      expect(post.status).toBe(401);
      expect(nonsense.status).toBe(401);
      expect(read.status).toBe(401);
    });

    it("checks the role before looking at the body", async () => {
      const { started } = await cashierApp();
      await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer" });
      const owner = await loginAs(started, "owner", "long enough pass");

      const response = await postJson(started, "/api/operations", { nonsense: true }, owner);

      expect(response.status).toBe(403);
    });
  });

  describe("client code suggestions", () => {
    async function recordCodes(started: TestApp, cookie: string, codes: string[]) {
      for (const [index, clientCode] of codes.entries()) {
        started.setNow(new Date(NOW.getTime() + index * 60_000));
        await postJson(started, "/api/operations", income({ clientCode }), cookie);
      }
    }

    async function suggestions(started: TestApp, cookie: string, query = "") {
      const response = await get(started, `/api/client-codes${query}`, cookie);
      return (await response.json()).codes;
    }

    it("refuses a prefix with a NUL character instead of failing inside the database", async () => {
      const { started, cookie } = await cashierApp();

      const response = await get(started, "/api/client-codes?prefix=a%00b", cookie);

      expect(response.status).toBe(400);
    });

    it("offers earlier codes that start with what was typed, most recently used first", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["K17", "K18", "M-5", "K17"]);

      expect(await suggestions(started, cookie, "?prefix=K1")).toEqual(["K17", "K18"]);
    });

    it("ignores letter case, in Cyrillic too", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["Б-5", "K17"]);

      expect(await suggestions(started, cookie, "?prefix=k1")).toEqual(["K17"]);
      expect(await suggestions(started, cookie, "?prefix=" + encodeURIComponent("б"))).toEqual(["Б-5"]);
    });

    it("lists each code once, spelled as it was last typed", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["K17", "k17", "K18"]);

      expect(await suggestions(started, cookie, "?prefix=k")).toEqual(["K18", "k17"]);
    });

    it("offers the most recent codes when nothing is typed yet, at most eight", async () => {
      const { started, cookie } = await cashierApp();
      const codes = Array.from({ length: 10 }, (_, i) => `C${i}`);
      await recordCodes(started, cookie, codes);

      expect(await suggestions(started, cookie)).toEqual(
        ["C9", "C8", "C7", "C6", "C5", "C4", "C3", "C2"],
      );
    });

    it("finds a code however long ago it was used", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["OLD-1"]);
      const later = Array.from({ length: 510 }, (_, i) => `NEW-${i}`);
      for (let from = 0; from < later.length; from += 60) {
        started.setNow(new Date(NOW.getTime() + (from + 1) * 60_000));
        await Promise.all(
          later
            .slice(from, from + 60)
            .map((clientCode) => postJson(started, "/api/operations", income({ clientCode }), cookie)),
        );
      }

      expect(await suggestions(started, cookie, "?prefix=old")).toEqual(["OLD-1"]);
    });

    it("treats % and _ in what was typed as ordinary characters", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["K_17", "KX17", "50%"]);

      expect(await suggestions(started, cookie, "?prefix=K_")).toEqual(["K_17"]);
      expect(await suggestions(started, cookie, "?prefix=50%25")).toEqual(["50%"]);
    });

    it("offers nothing for a prefix nobody used, and only to logged-in users", async () => {
      const { started, cookie } = await cashierApp();
      await recordCodes(started, cookie, ["K17"]);

      expect(await suggestions(started, cookie, "?prefix=zzz")).toEqual([]);
      expect((await get(started, "/api/client-codes")).status).toBe(401);
    });
  });

  describe("default currency", () => {
    async function defaultCurrency(started: TestApp, cookie: string) {
      const response = await get(started, "/api/operations/defaults", cookie);
      return (await response.json()).currency;
    }

    it("is the ruble until the cashier has recorded anything", async () => {
      const { started, cookie } = await cashierApp();

      expect(await defaultCurrency(started, cookie)).toBe("RUB");
    });

    it("is the currency this cashier used last", async () => {
      const { started, cookie } = await cashierApp();
      await postJson(started, "/api/operations", income({ currency: "RUB" }), cookie);
      started.setNow(new Date(NOW.getTime() + 60_000));
      await postJson(started, "/api/operations", income({ currency: "USD" }), cookie);

      expect(await defaultCurrency(started, cookie)).toBe("USD");

      started.setNow(new Date(NOW.getTime() + 120_000));
      await postJson(started, "/api/operations", income({ currency: "RUB" }), cookie);

      expect(await defaultCurrency(started, cookie)).toBe("RUB");
    });

    it("does not follow what other cashiers used", async () => {
      const { started, cookie } = await cashierApp();
      await started.admin.createUser({ login: "petr", password: "battery staple", role: "cashier" });
      const petr = await loginAs(started, "petr", "battery staple");
      await postJson(started, "/api/operations", income({ currency: "USD" }), cookie);

      expect(await defaultCurrency(started, petr)).toBe("RUB");
    });
  });
});
