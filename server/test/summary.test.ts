import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

// 11:30 in Moscow (UTC+3), the middle of 10 March.
const NOW = new Date("2026-03-10T08:30:00Z");

type Entry = Record<string, unknown>;

type Summary = {
  from: string;
  to: string;
  currencies: Array<{
    currency: string;
    openingMinor: number;
    incomeMinor: number;
    expenseMinor: number;
    handoverMinor: number;
    closingMinor: number;
    expenseByCategory: Array<{ category: string; amountMinor: number }>;
  }>;
};

describe("the totals for a period", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two cashiers and the viewer, the clock standing at NOW. Opening balances: 10 000,00 RUB and 50,00 USD. */
  async function desk() {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "10000");
    await started.admin.setOpeningBalance("USD", "50");
    app = started;
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 100_000, currency: "RUB", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });

  /** Records an operation as `cookie` with the clock set to `at`; returns its id. */
  async function record(started: TestApp, cookie: string, at: string, body: Entry): Promise<string> {
    started.setNow(new Date(at));
    const response = await postJson(started, "/api/operations", body, cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    started.setNow(NOW);
    return body.id as string;
  }

  async function summary(started: TestApp, cookie: string | undefined, query = "") {
    const response = await get(started, `/api/summary${query}`, cookie);
    return { status: response.status, body: (await response.json()) as Summary & Record<string, unknown> };
  }

  const of = (body: Summary, currency: string) => body.currencies.find((item) => item.currency === currency)!;

  describe("what is counted", () => {
    it("gives, for each currency, the opening balance, income, expense by category, handover and the closing balance of the days asked for", async () => {
      const { started, ivan, owner } = await desk();
      // Before the period: 5 000,00 in, 2 000,00 out.
      await record(started, ivan, "2026-03-01T09:00:00Z", income({ amountMinor: 500_000 }));
      await record(started, ivan, "2026-03-02T09:00:00Z", expense({ amountMinor: 200_000 }));
      // In the period, 5 to 7 March.
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 300_000 }));
      await record(started, ivan, "2026-03-07T09:00:00Z", income({ amountMinor: 100_000, clientCode: "K18" }));
      await record(started, ivan, "2026-03-06T09:00:00Z", expense({ amountMinor: 50_000, category: "fuel_road" }));
      await record(started, ivan, "2026-03-06T10:00:00Z", expense({ amountMinor: 120_000, category: "salaries" }));
      await record(started, ivan, "2026-03-07T10:00:00Z", expense({ amountMinor: 20_000, category: "client_refund", clientCode: "K17" }));
      await record(started, ivan, "2026-03-07T11:00:00Z", expense({ amountMinor: 40_000, category: "owner_handover", recipient: "Азамат" }));
      await record(started, ivan, "2026-03-07T12:00:00Z", expense({ amountMinor: 5_000, category: "other" }));
      // After the period.
      await record(started, ivan, "2026-03-08T09:00:00Z", income({ amountMinor: 999_999 }));

      const { status, body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-07");

      expect(status).toBe(200);
      expect(body).toEqual({
        from: "2026-03-05",
        to: "2026-03-07",
        currencies: [
          {
            currency: "RUB",
            // 10 000,00 + 5 000,00 - 2 000,00
            openingMinor: 1_300_000,
            incomeMinor: 400_000,
            expenseMinor: 195_000,
            handoverMinor: 40_000,
            // 13 000,00 + 4 000,00 - 1 950,00 - 400,00
            closingMinor: 1_465_000,
            expenseByCategory: [
              { category: "fuel_road", amountMinor: 50_000 },
              { category: "salaries", amountMinor: 120_000 },
              { category: "household_repair", amountMinor: 0 },
              { category: "client_refund", amountMinor: 20_000 },
              { category: "other", amountMinor: 5_000 },
            ],
          },
          {
            currency: "USD",
            openingMinor: 5_000,
            incomeMinor: 0,
            expenseMinor: 0,
            handoverMinor: 0,
            closingMinor: 5_000,
            expenseByCategory: [
              { category: "fuel_road", amountMinor: 0 },
              { category: "salaries", amountMinor: 0 },
              { category: "household_repair", amountMinor: 0 },
              { category: "client_refund", amountMinor: 0 },
              { category: "other", amountMinor: 0 },
            ],
          },
        ],
      });
    });

    it("keeps the currencies apart and never adds them up", async () => {
      const { started, ivan, owner } = await desk();
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 250_000, currency: "RUB" }));
      await record(started, ivan, "2026-03-05T10:00:00Z", income({ amountMinor: 12_050, currency: "USD", clientCode: "K18" }));
      await record(started, ivan, "2026-03-05T11:00:00Z", expense({ amountMinor: 3_000, currency: "USD", category: "household_repair" }));

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(of(body, "RUB")).toMatchObject({ incomeMinor: 250_000, expenseMinor: 0, openingMinor: 1_000_000, closingMinor: 1_250_000 });
      expect(of(body, "USD")).toMatchObject({ incomeMinor: 12_050, expenseMinor: 3_000, openingMinor: 5_000, closingMinor: 14_050 });
      expect(Object.keys(body).sort()).toEqual(["currencies", "from", "to"]);
    });

    it("counts what every cashier made, not only one", async () => {
      const { started, ivan, petr, owner } = await desk();
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 100_000 }));
      await record(started, petr, "2026-03-05T10:00:00Z", income({ amountMinor: 200_000, clientCode: "K18" }));

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(of(body, "RUB").incomeMinor).toBe(300_000);
    });

    it("always has both currencies, RUB first, with zeros when nothing happened, and the opening balance as the closing one", async () => {
      const { started, owner } = await desk();

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(body.currencies.map((item) => item.currency)).toEqual(["RUB", "USD"]);
      expect(of(body, "RUB")).toMatchObject({ openingMinor: 1_000_000, incomeMinor: 0, expenseMinor: 0, handoverMinor: 0, closingMinor: 1_000_000 });
      expect(of(body, "USD")).toMatchObject({ openingMinor: 5_000, closingMinor: 5_000 });
    });

    it("always adds up: the opening balance plus income minus expense minus handover is the closing balance, whatever the period", async () => {
      const { started, ivan, owner } = await desk();
      const days = ["2026-02-27", "2026-03-01", "2026-03-03", "2026-03-04", "2026-03-06", "2026-03-09"];
      for (const [index, day] of days.entries()) {
        await record(started, ivan, `${day}T10:00:00Z`, income({ amountMinor: 100_000 + index * 7_001, currency: index % 2 ? "USD" : "RUB" }));
        const category = ["fuel_road", "owner_handover", "client_refund", "other", "salaries", "household_repair"][index]!;
        await record(
          started,
          ivan,
          `${day}T11:00:00Z`,
          expense({ amountMinor: 3_000 + index * 11, category, currency: index % 2 ? "USD" : "RUB", ...(category === "client_refund" ? { clientCode: "K17" } : {}) }),
        );
      }

      for (const [from, to] of [["2026-02-27", "2026-03-09"], ["2026-03-01", "2026-03-03"], ["2026-03-04", "2026-03-04"], ["2026-03-05", "2026-03-08"], ["2026-01-01", "2026-12-31"]]) {
        const { body } = await summary(started, owner, `?from=${from}&to=${to}`);
        for (const item of body.currencies) {
          expect(item.openingMinor + item.incomeMinor - item.expenseMinor - item.handoverMinor, `${item.currency} ${from}..${to}`).toBe(item.closingMinor);
          expect(item.expenseByCategory.reduce((sum, row) => sum + row.amountMinor, 0), `${item.currency} ${from}..${to}`).toBe(item.expenseMinor);
        }
      }
    });

    it("agrees with the balances the cash desk shows: the closing balance of a period that reaches today is the balance now", async () => {
      const { started, ivan, owner } = await desk();
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 321_000 }));
      await record(started, ivan, "2026-03-08T09:00:00Z", expense({ amountMinor: 54_321, category: "other" }));

      const balances = (await (await get(started, "/api/balances", owner)).json()).balances as Array<{ currency: string; amountMinor: number }>;
      const { body } = await summary(started, owner, "?from=2026-03-01&to=2026-03-10");

      for (const balance of balances) expect(of(body, balance.currency).closingMinor).toBe(balance.amountMinor);
    });
  });

  describe("the days are Moscow days", () => {
    it("starts a day at midnight in Moscow and ends it there, to the second", async () => {
      const { started, ivan, owner } = await desk();
      // 22:59:59 and 23:59:59 in Moscow on 4 March, then midnight, then the last second of 5 March, then 6 March.
      await record(started, ivan, "2026-03-04T19:59:59Z", income({ amountMinor: 1_000 }));
      await record(started, ivan, "2026-03-04T20:59:59Z", income({ amountMinor: 2_000 }));
      await record(started, ivan, "2026-03-04T21:00:00Z", income({ amountMinor: 4_000 }));
      await record(started, ivan, "2026-03-05T20:59:59Z", income({ amountMinor: 8_000 }));
      await record(started, ivan, "2026-03-05T21:00:00Z", income({ amountMinor: 16_000 }));

      const day = (await summary(started, owner, "?from=2026-03-05&to=2026-03-05")).body;
      const before = (await summary(started, owner, "?from=2026-03-04&to=2026-03-04")).body;

      expect(of(day, "RUB").incomeMinor).toBe(4_000 + 8_000);
      expect(of(day, "RUB").openingMinor).toBe(1_000_000 + 1_000 + 2_000);
      expect(of(day, "RUB").closingMinor).toBe(1_000_000 + 1_000 + 2_000 + 4_000 + 8_000);
      expect(of(before, "RUB").incomeMinor).toBe(1_000 + 2_000);
    });

    it("reads one date alone as that day, and none as today", async () => {
      const { started, ivan, owner } = await desk();
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 111_000 }));
      await record(started, ivan, "2026-03-10T07:00:00Z", income({ amountMinor: 222_000, clientCode: "K18" }));

      const onlyFrom = (await summary(started, owner, "?from=2026-03-05")).body;
      const onlyTo = (await summary(started, owner, "?to=2026-03-05")).body;
      const none = (await summary(started, owner)).body;

      expect([onlyFrom.from, onlyFrom.to]).toEqual(["2026-03-05", "2026-03-05"]);
      expect(of(onlyFrom, "RUB").incomeMinor).toBe(111_000);
      expect([onlyTo.from, onlyTo.to]).toEqual(["2026-03-05", "2026-03-05"]);
      expect([none.from, none.to]).toEqual(["2026-03-10", "2026-03-10"]);
      expect(of(none, "RUB").incomeMinor).toBe(222_000);
    });

    it("takes a day of the future as it is: nothing happened in it yet, and the closing balance is the balance now", async () => {
      const { started, ivan, owner } = await desk();
      await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 100_000 }));

      const { status, body } = await summary(started, owner, "?from=2026-03-20&to=2026-03-25");

      expect(status).toBe(200);
      expect(of(body, "RUB")).toMatchObject({ openingMinor: 1_100_000, incomeMinor: 0, closingMinor: 1_100_000 });
    });
  });

  describe("what does not count, or counts as it stands now", () => {
    it("leaves out a deleted operation, in the totals and in the balances", async () => {
      const { started, ivan, owner } = await desk();
      const kept = await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 100_000 }));
      const removed = await record(started, ivan, "2026-03-05T10:00:00Z", income({ amountMinor: 700_000, clientCode: "K18" }));
      const removedExpense = await record(started, ivan, "2026-03-05T11:00:00Z", expense({ amountMinor: 50_000, category: "owner_handover" }));
      const before = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");
      expect(of(before.body, "RUB")).toMatchObject({ incomeMinor: 800_000, handoverMinor: 50_000, closingMinor: 1_750_000 });

      expect((await deleteRequest(started, `/api/operations/${removed}`, ivan, { reason: "дубль" })).status).toBe(200);
      expect((await deleteRequest(started, `/api/operations/${removedExpense}`, ivan)).status).toBe(200);

      const after = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");
      expect(of(after.body, "RUB")).toMatchObject({ incomeMinor: 100_000, handoverMinor: 0, expenseMinor: 0, closingMinor: 1_100_000 });
      // A later day sees the same opening balance.
      const later = await summary(started, owner, "?from=2026-03-06&to=2026-03-06");
      expect(of(later.body, "RUB").openingMinor).toBe(1_100_000);
      expect(kept).toBeTruthy();
    });

    it("counts a corrected operation as it says now, in the period it was made in", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 100_000 }));
      const edit = await putJson(started, `/api/operations/${id}`, { type: "income", amountMinor: 160_000, currency: "RUB", clientCode: "K17" }, ivan);
      expect(edit.status, await edit.clone().text()).toBe(200);

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(of(body, "RUB")).toMatchObject({ incomeMinor: 160_000, closingMinor: 1_160_000 });
    });

    it("moves an operation to the other currency when it was corrected into it", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, "2026-03-05T09:00:00Z", income({ amountMinor: 20_000, currency: "RUB" }));
      const edit = await putJson(started, `/api/operations/${id}`, { type: "income", amountMinor: 20_000, currency: "USD", clientCode: "K17" }, ivan);
      expect(edit.status, await edit.clone().text()).toBe(200);

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(of(body, "RUB").incomeMinor).toBe(0);
      expect(of(body, "USD").incomeMinor).toBe(20_000);
    });
  });

  describe("who may ask, and how", () => {
    it("refuses a cashier, and a visitor who has not signed in", async () => {
      const { started, ivan } = await desk();

      expect((await summary(started, ivan, "?from=2026-03-05&to=2026-03-05")).status).toBe(403);
      expect((await summary(started, undefined, "?from=2026-03-05&to=2026-03-05")).status).toBe(401);
    });

    it("refuses what is not a period: a start after the end, a date that is not one, other parameters", async () => {
      const { started, owner } = await desk();

      for (const query of [
        "?from=2026-03-07&to=2026-03-05",
        "?from=2026-02-30&to=2026-03-05",
        "?from=05.03.2026",
        "?from=2026-03-05&currency=RUB",
        "?from=2026-03-05&to=",
        "?from[]=2026-03-05",
      ]) {
        const { status } = await summary(started, owner, query);
        expect(status, query).toBe(400);
      }
    });
  });

  describe("where the database could get in the way", () => {
    it("adds up exactly, to the kopeck, with many operations and large amounts", async () => {
      const { started, ivan, owner } = await desk();
      let income_ = 0;
      for (let index = 0; index < 40; index++) {
        const amount = 99_999_999_99 - index * 1_234_567;
        income_ += amount;
        await record(started, ivan, `2026-03-05T${String(6 + (index % 12)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`, income({ amountMinor: amount, clientCode: `K${index}` }));
      }

      const { body } = await summary(started, owner, "?from=2026-03-05&to=2026-03-05");

      expect(of(body, "RUB").incomeMinor).toBe(income_);
      expect(of(body, "RUB").closingMinor).toBe(1_000_000 + income_);
    }, 60_000);
  });
});
