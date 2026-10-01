import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const OPENED = new Date("2026-03-05T08:30:00Z");
const CLOSED = new Date("2026-03-05T15:00:00Z");

type Entry = Record<string, unknown>;

/** The exchange rate of a ruble operation, and the dollars the owner counts everything in. */
describe("the rate and the dollars", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    started.setNow(OPENED);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 79_000, currency: "RUB", rateE4: 790_000, clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 79_000, currency: "RUB", category: "fuel_road", ...overrides });
  const counted = { counted: [{ currency: "RUB", amountMinor: 0 }, { currency: "USD", amountMinor: 0 }] };

  async function post(started: TestApp, cookie: string, body: Entry) {
    const response = await postJson(started, "/api/operations", body, cookie);
    return { status: response.status, body: await response.json() };
  }

  /** What the owner reads in the journal of the day. */
  async function journal(started: TestApp, owner: string) {
    const response = await get(started, "/api/operations?from=2026-03-05&to=2026-03-05", owner);
    return (await response.json()).operations as Array<Record<string, unknown>>;
  }

  async function summary(started: TestApp, owner: string) {
    return (await (await get(started, "/api/summary?from=2026-03-05&to=2026-03-05", owner)).json()) as {
      usd: { incomeMinor: number; expenseMinor: number; handoverMinor: number; resultMinor: number; withoutRate: Record<string, { rubMinor: number; count: number }> };
    };
  }

  describe("what a cashier may send", () => {
    it("takes an income in rubles with a rate, and says what it is in dollars", async () => {
      const { started, ivan } = await desk();

      const answer = await post(started, ivan, income({ amountMinor: 5_000_000, rateE4: 784_000 }));

      expect(answer.status).toBe(201);
      // 50 000,00 rubles at 78,4: 637,76 dollars.
      expect(answer.body.operation).toMatchObject({ rateE4: 784_000, usdMinor: 63_776, rateSource: "own" });
    });

    it("refuses an income in rubles without a rate", async () => {
      const { started, ivan } = await desk();
      const { rateE4: _rate, ...without } = income();

      const answer = await post(started, ivan, without);

      expect(answer.status).toBe(400);
      expect(answer.body.message).toContain("rateE4");
    });

    it("takes an expense in rubles with or without a rate", async () => {
      const { started, ivan } = await desk();

      const without = await post(started, ivan, expense());
      const withIt = await post(started, ivan, expense({ rateE4: 800_000 }));

      expect(without.body.operation).toMatchObject({ rateE4: null, usdMinor: null, rateSource: null });
      expect(withIt.body.operation).toMatchObject({ rateE4: 800_000, usdMinor: 988, rateSource: "own" });
    });

    it("refuses a rate on dollars, an income or an expense", async () => {
      const { started, ivan } = await desk();

      const gain = await post(started, ivan, income({ currency: "USD", rateE4: 790_000 }));
      const spend = await post(started, ivan, expense({ currency: "USD", rateE4: 790_000 }));

      expect(gain.status).toBe(400);
      expect(spend.status).toBe(400);
    });

    it("takes dollars as they are, counted for what they are in dollars", async () => {
      const { started, ivan } = await desk();

      const answer = await post(started, ivan, income({ currency: "USD", rateE4: undefined, amountMinor: 12_345 }));

      expect(answer.body.operation).toMatchObject({ rateE4: null, usdMinor: 12_345, rateSource: null });
    });

    it.each([0, 9_999, 10_000_001, 1.5, "79"])("refuses a rate of %s", async (rateE4) => {
      const { started, ivan } = await desk();

      expect((await post(started, ivan, income({ rateE4 }))).status).toBe(400);
    });

    it.each([10_000, 10_000_000])("takes the rate at the edge, %s", async (rateE4) => {
      const { started, ivan } = await desk();

      expect((await post(started, ivan, income({ rateE4 }))).status).toBe(201);
    });

    it("rounds to the nearest cent, half up, in whole numbers", async () => {
      const { started, ivan } = await desk();

      // 0,01 ruble at 1: a cent exactly, and 1 kopeck at 200 is half a cent, which goes up.
      const one = await post(started, ivan, income({ amountMinor: 1, rateE4: 10_000 }));
      const half = await post(started, ivan, income({ amountMinor: 1, rateE4: 2_000_000 }));

      expect(one.body.operation.usdMinor).toBe(1);
      expect(half.body.operation.usdMinor).toBe(0);
      const larger = await post(started, ivan, income({ amountMinor: 100, rateE4: 2_000_000 }));
      expect(larger.body.operation.usdMinor).toBe(1);
    });
  });

  describe("correcting it", () => {
    it("changes the rate with a line of history that says what it was", async () => {
      const { started, ivan, owner } = await desk();
      const body = income();
      await post(started, ivan, body);

      const edit = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 79_000, currency: "RUB", rateE4: 800_000, clientCode: "K17" }, ivan);

      expect(edit.status).toBe(200);
      expect((await edit.json()).operation).toMatchObject({ rateE4: 800_000, usdMinor: 988, revision: 1 });
      const history = await (await get(started, `/api/operations/${body.id}/history`, owner)).json();
      expect(history.changes[0]).toMatchObject({ before: { rateE4: 790_000 }, after: { rateE4: 800_000 } });
    });

    it("must lose the rate when it becomes dollars, and must have one when it becomes rubles", async () => {
      const { started, ivan } = await desk();
      const body = income();
      await post(started, ivan, body);

      const withRate = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 100, currency: "USD", rateE4: 790_000, clientCode: "K17" }, ivan);
      const toDollars = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 100, currency: "USD", clientCode: "K17" }, ivan);
      const back = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 100, currency: "RUB", clientCode: "K17" }, ivan);

      expect(withRate.status).toBe(400);
      expect(toDollars.status).toBe(200);
      expect((await toDollars.json()).operation).toMatchObject({ rateE4: null, usdMinor: 100 });
      expect(back.status).toBe(400);
    });

    it("counts a changed rate in the totals at once", async () => {
      const { started, ivan, owner } = await desk();
      const body = income();
      await post(started, ivan, body);
      expect((await summary(started, owner)).usd.incomeMinor).toBe(1_000);

      await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 79_000, currency: "RUB", rateE4: 395_000, clientCode: "K17" }, ivan);

      expect((await summary(started, owner)).usd.incomeMinor).toBe(2_000);
    });
  });

  describe("the average rate of a shift, when it is closed", () => {
    async function open(started: TestApp, cookie: string) {
      return (await (await postJson(started, "/api/shifts", {}, cookie)).json()).shift as { id: string };
    }
    const close = (started: TestApp, id: string, cookie: string) => postJson(started, `/api/shifts/${id}/close`, counted, cookie);

    it("is the average of the rates of the ruble incomes of the shift, fixed at closing", async () => {
      const { started, ivan } = await desk();
      const shift = await open(started, ivan);
      await post(started, ivan, income({ rateE4: 780_000 }));
      await post(started, ivan, income({ rateE4: 790_000 }));
      await post(started, ivan, income({ rateE4: 800_000 }));
      await post(started, ivan, income({ currency: "USD", rateE4: undefined, amountMinor: 100 }));
      started.setNow(CLOSED);

      const closed = await (await close(started, shift.id, ivan)).json();

      expect(closed.shift.averageRateE4).toBe(790_000);
    });

    it("counts the expenses without a rate at the average once the shift is closed, and not before", async () => {
      const { started, ivan, owner } = await desk();
      const shift = await open(started, ivan);
      await post(started, ivan, income({ amountMinor: 790_000, rateE4: 790_000 }));
      await post(started, ivan, expense({ amountMinor: 395_000 }));
      await post(started, ivan, expense({ amountMinor: 395_000, rateE4: 800_000 }));

      // The shift is open: the expense without a rate is not in dollars yet, and the totals say so.
      const before = await summary(started, owner);
      expect(before.usd).toMatchObject({ incomeMinor: 10_000, expenseMinor: 4_938, withoutRate: { expense: { rubMinor: 395_000, count: 1 } } });
      expect((await journal(started, owner)).find((item) => item.amountMinor === 395_000 && item.rateSource === null)).toMatchObject({ usdMinor: null });

      started.setNow(CLOSED);
      await close(started, shift.id, ivan);

      // 3 950,00 rubles at the average 79: 50,00 dollars, and the other one at its own 80: 49,38.
      const after = await summary(started, owner);
      expect(after.usd).toEqual({
        incomeMinor: 10_000,
        expenseMinor: 5_000 + 4_938,
        handoverMinor: 0,
        resultMinor: 10_000 - 5_000 - 4_938,
        withoutRate: { income: { rubMinor: 0, count: 0 }, expense: { rubMinor: 0, count: 0 } },
      });
      const shown = (await journal(started, owner)).find((item) => item.amountMinor === 395_000 && item.rateE4 === null);
      expect(shown).toMatchObject({ usdMinor: 5_000, rateSource: "shift" });
    });

    it("takes the last rate of an income when the shift had none of its own, and none when there never was one", async () => {
      const { started, ivan } = await desk();
      const first = await open(started, ivan);
      await post(started, ivan, income({ rateE4: 770_000 }));
      started.setNow(CLOSED);
      await close(started, first.id, ivan);
      const second = await open(started, ivan);
      started.setNow(new Date("2026-03-05T20:00:00Z"));

      const closed = await (await close(started, second.id, ivan)).json();

      expect(closed.shift.averageRateE4).toBe(770_000);

      const other = await desk();
      const alone = await open(other.started, other.ivan);
      const empty = await (await close(other.started, alone.id, other.ivan)).json();
      expect(empty.shift.averageRateE4).toBeNull();
    });

    it("leaves an expense outside any shift without dollars, and says so in the totals", async () => {
      const { started, ivan, owner } = await desk();
      await post(started, ivan, expense({ amountMinor: 120_000 }));

      const { usd } = await summary(started, owner);

      expect(usd).toMatchObject({ expenseMinor: 0, withoutRate: { expense: { rubMinor: 120_000, count: 1 } } });
    });

    it("does not count a deleted operation", async () => {
      const { started, ivan, owner } = await desk();
      const body = income();
      await post(started, ivan, body);
      await deleteRequest(started, `/api/operations/${body.id}`, ivan);

      expect((await summary(started, owner)).usd.incomeMinor).toBe(0);
    });
  });

  describe("the totals in dollars", () => {
    it("add up dollars and rubles at their rates, the handover on its own, and leave the balances as they are", async () => {
      const { started, ivan, owner } = await desk();
      await post(started, ivan, income({ currency: "USD", rateE4: undefined, amountMinor: 50_000 }));
      await post(started, ivan, income({ amountMinor: 790_000, rateE4: 790_000 }));
      await post(started, ivan, expense({ currency: "USD", amountMinor: 10_000 }));
      await post(started, ivan, expense({ amountMinor: 158_000, rateE4: 790_000 }));
      await post(started, ivan, expense({ category: "owner_handover", recipient: "Азамат", currency: "USD", amountMinor: 20_000 }));

      const { usd } = await summary(started, owner);

      expect(usd).toEqual({
        incomeMinor: 50_000 + 10_000,
        expenseMinor: 10_000 + 2_000,
        handoverMinor: 20_000,
        resultMinor: 60_000 - 12_000,
        withoutRate: { income: { rubMinor: 0, count: 0 }, expense: { rubMinor: 0, count: 0 } },
      });
      const balances = (await (await get(started, "/api/balances", ivan)).json()).balances;
      expect(balances).toEqual([
        { currency: "RUB", amountMinor: 790_000 - 158_000 },
        { currency: "USD", amountMinor: 50_000 - 10_000 - 20_000 },
      ]);
    });
  });
});
