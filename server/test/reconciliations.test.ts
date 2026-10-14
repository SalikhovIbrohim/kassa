import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

const WORKED = new Date("2026-03-05T08:30:00Z");
const COUNTED = new Date("2026-03-05T15:00:00Z");

type Entry = Record<string, unknown>;

/** Counting the cash against the book: one person, the head cashier, does it whenever they like. No shifts to open or close. */
describe("reconciling the cash desk", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A head cashier, two cashiers, the owner and an admin; opening balances 1 000,00 RUB and 50,00 USD. */
  async function desk() {
    const started = await startTestApp();
    app = started;
    started.setNow(WORKED);
    await started.admin.createUser({ login: "anvar", password: "admin pass word", role: "head_cashier", displayName: "Анвар" });
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "1000");
    await started.admin.setOpeningBalance("USD", "50");
    return {
      started,
      anvar: await loginAs(started, "anvar", "admin pass word"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
      mudir: await loginAs(started, "mudir", "admin password"),
    };
  }

  const income = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });
  const counted = (rub: number, usd: number) => ({ counted: [{ currency: "RUB", amountMinor: rub }, { currency: "USD", amountMinor: usd }] });
  const reconcile = (started: TestApp, body: unknown, cookie?: string) => postJson(started, "/api/reconciliations", body, cookie);
  const withId = (body: Entry, id = randomUUID()) => ({ id, ...body });

  /** Ivan enters 500,00 in, 100,00 out in rubles and 20,00 in dollars: the book says 1 400,00 and 70,00. */
  async function workedDay() {
    const d = await desk();
    await postJson(d.started, "/api/operations", income({ amountMinor: 50_000 }), d.ivan);
    await postJson(d.started, "/api/operations", expense({ amountMinor: 10_000 }), d.ivan);
    await postJson(d.started, "/api/operations", income({ amountMinor: 2_000, currency: "USD" }), d.ivan);
    d.started.setNow(COUNTED);
    return d;
  }

  it("counts the rubles on the cards with the rubles in the box: one book of rubles, the card part kept apart", async () => {
    const { started, anvar } = await workedDay();
    // The book says 1 400,00: 900,00 in the box and 500,00 on the cards agree with it.
    const made = await (await reconcile(started, withId({ ...counted(90_000, 7_000), cardMinor: 50_000 }), anvar)).json();
    expect(made.reconciliation.cardMinor).toBe(50_000);
    expect(made.reconciliation.currencies[0]).toEqual({ currency: "RUB", calculatedMinor: 140_000, actualMinor: 140_000, differenceMinor: 0 });
    expect(made.balances).toEqual([{ currency: "RUB", amountMinor: 140_000 }, { currency: "USD", amountMinor: 7_000 }]);
    const without = await (await reconcile(started, withId(counted(140_000, 7_000)), anvar)).json();
    expect(without.reconciliation.cardMinor).toBeNull();
    expect((await reconcile(started, withId({ ...counted(1, 1), cardMinor: -1 }), anvar)).status).toBe(400);
  });

  it("keeps, per currency, what the book said, what was counted and the difference, in the name of the head cashier", async () => {
    const { started, anvar } = await workedDay();
    const id = randomUUID();

    const response = await reconcile(started, { id, ...counted(139_000, 7_500) }, anvar);

    expect(response.status).toBe(201);
    expect((await response.json()).reconciliation).toEqual({
      id,
      madeAt: "2026-03-05T15:00:00.000Z",
      madeBy: { login: "anvar", displayName: "Анвар" },
      currencies: [
        { currency: "RUB", calculatedMinor: 140_000, actualMinor: 139_000, differenceMinor: -1_000 },
        { currency: "USD", calculatedMinor: 7_000, actualMinor: 7_500, differenceMinor: 500 },
      ],
      cardMinor: null,
    });
  });

  it("finds no difference when the count agrees with the book", async () => {
    const { started, anvar } = await workedDay();

    const { reconciliation } = await (await reconcile(started, withId(counted(140_000, 7_000)), anvar)).json();

    expect(reconciliation.currencies.map((item: { differenceMinor: number }) => item.differenceMinor)).toEqual([0, 0]);
  });

  it("makes the book say what was counted, in the answer and from then on", async () => {
    const { started, anvar, ivan } = await workedDay();

    const made = await (await reconcile(started, withId(counted(139_000, 7_500)), anvar)).json();

    const balances = [
      { currency: "RUB", amountMinor: 139_000 },
      { currency: "USD", amountMinor: 7_500 },
    ];
    expect(made.balances).toEqual(balances);
    expect(await (await get(started, "/api/balances", ivan)).json()).toEqual({ balances });
    // The next entry goes on from what was counted.
    const next = await postJson(started, "/api/operations", income({ amountMinor: 1_000 }), ivan);
    expect((await next.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: 140_000 });
  });

  it("takes an expense above what was counted: the balance goes below zero", async () => {
    const { started, anvar, ivan } = await workedDay();
    await reconcile(started, withId(counted(139_000, 7_500)), anvar);

    const tooMuch = await postJson(started, "/api/operations", expense({ amountMinor: 139_001 }), ivan);

    expect(tooMuch.status).toBe(201);
    expect((await tooMuch.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: -1 });
  });

  it("counts against everything the book holds, whoever entered it", async () => {
    const { started, anvar, petr } = await workedDay();
    await postJson(started, "/api/operations", income({ amountMinor: 30_000 }), petr);

    const { reconciliation } = await (await reconcile(started, withId(counted(170_000, 7_000)), anvar)).json();

    expect(reconciliation.currencies[0]).toMatchObject({ calculatedMinor: 170_000, actualMinor: 170_000, differenceMinor: 0 });
  });

  it("can be made again and again, each against the book as the one before left it", async () => {
    const { started, anvar } = await workedDay();
    await reconcile(started, withId(counted(139_000, 7_500)), anvar);

    const second = await (await reconcile(started, withId(counted(138_000, 7_500)), anvar)).json();

    expect(second.reconciliation.currencies[0]).toMatchObject({ calculatedMinor: 139_000, actualMinor: 138_000, differenceMinor: -1_000 });
  });

  it("refuses what is not a count of both currencies", async () => {
    const { started, anvar, owner } = await workedDay();
    const bad: unknown[] = [
      {},
      { id: randomUUID() },
      { counted: [] },
      withId({ counted: [] }),
      withId({ counted: [{ currency: "RUB", amountMinor: 1 }] }),
      withId({ counted: [{ currency: "RUB", amountMinor: 1 }, { currency: "RUB", amountMinor: 2 }] }),
      withId({ counted: [{ currency: "RUB", amountMinor: -1 }, { currency: "USD", amountMinor: 0 }] }),
      withId({ counted: [{ currency: "RUB", amountMinor: 1.5 }, { currency: "USD", amountMinor: 0 }] }),
      withId({ counted: [{ currency: "EUR", amountMinor: 1 }, { currency: "USD", amountMinor: 0 }] }),
      withId({ counted: [{ currency: "RUB", amountMinor: "100" }, { currency: "USD", amountMinor: 0 }] }),
      withId({ ...counted(1, 1), extra: true }),
      { id: "not-an-id", ...counted(1, 1) },
    ];

    for (const body of bad) expect((await reconcile(started, body, anvar)).status, JSON.stringify(body)).toBe(400);

    // Nothing was counted by any of them; an empty cash desk is a count too.
    expect((await (await get(started, "/api/reconciliations", owner)).json()).reconciliations).toEqual([]);
    expect((await reconcile(started, withId(counted(0, 0)), anvar)).status).toBe(201);
  });

  it("is for the head cashier: not a cashier, not the owner, not the admin, nobody without a session", async () => {
    const { started, ivan, owner, mudir } = await workedDay();
    expect((await reconcile(started, withId(counted(1, 1)), mudir)).status).toBe(403);

    expect((await reconcile(started, withId(counted(1, 1)), ivan)).status).toBe(403);
    expect((await reconcile(started, withId(counted(1, 1)), owner)).status).toBe(403);
    expect((await reconcile(started, withId(counted(1, 1)))).status).toBe(401);
    // Nothing was written, so the book is as it was.
    expect((await (await get(started, "/api/balances", ivan)).json()).balances[0].amountMinor).toBe(140_000);
  });

  it("answers the same count sent again as the first time, and refuses another count or another head cashier under the same id", async () => {
    const { started, anvar, owner } = await workedDay();
    await started.admin.createUser({ login: "second", password: "second admin pass", role: "head_cashier" });
    const second = await loginAs(started, "second", "second admin pass");
    const id = randomUUID();
    const first = await (await reconcile(started, { id, ...counted(139_000, 7_500) }, anvar)).json();
    started.setNow(new Date("2026-03-05T16:00:00Z"));

    const again = await reconcile(started, { id, ...counted(139_000, 7_500) }, anvar);
    const other = await reconcile(started, { id, ...counted(100_000, 7_500) }, anvar);
    const stranger = await reconcile(started, { id, ...counted(139_000, 7_500) }, second);

    expect(again.status).toBe(200);
    expect((await again.json()).reconciliation).toEqual(first.reconciliation);
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "reconciliation_id_conflict" });
    expect(stranger.status).toBe(409);
    // Neither moved the book, and there is one count, not three.
    expect((await (await get(started, "/api/balances", anvar)).json()).balances[0].amountMinor).toBe(139_000);
    expect((await (await get(started, "/api/reconciliations", owner)).json()).reconciliations).toHaveLength(1);
  });

  it("lists the counts for the owner and the admin, newest first, with how they came out", async () => {
    const { started, anvar, owner, mudir } = await workedDay();
    const first = randomUUID();
    const second = randomUUID();
    await reconcile(started, { id: first, ...counted(139_000, 7_500) }, anvar);
    started.setNow(new Date("2026-03-06T20:00:00Z"));
    await reconcile(started, { id: second, ...counted(139_000, 7_500) }, anvar);

    for (const cookie of [owner, mudir]) {
      const response = await get(started, "/api/reconciliations", cookie);
      expect(response.status).toBe(200);
      const { reconciliations, nextBefore } = await response.json();
      expect(nextBefore).toBeNull();
      expect(reconciliations.map((item: { id: string }) => item.id)).toEqual([second, first]);
      expect(reconciliations[0]).toMatchObject({ madeBy: { login: "anvar" } });
      expect(reconciliations[1].currencies[0]).toMatchObject({ differenceMinor: -1_000 });
    }
  });

  it("pages through the counts, and keeps the list from cashiers and from strangers", async () => {
    const { started, anvar, ivan, owner } = await desk();
    for (const day of ["01", "02", "03"]) {
      started.setNow(new Date(`2026-03-${day}T16:00:00Z`));
      await reconcile(started, withId(counted(100_000, 5_000)), anvar);
    }

    const first = await (await get(started, "/api/reconciliations?limit=2", owner)).json();
    const second = await (await get(started, `/api/reconciliations?limit=2&before=${encodeURIComponent(first.nextBefore)}`, owner)).json();

    expect(first.reconciliations.map((item: { madeAt: string }) => item.madeAt.slice(0, 10))).toEqual(["2026-03-03", "2026-03-02"]);
    expect(second.reconciliations.map((item: { madeAt: string }) => item.madeAt.slice(0, 10))).toEqual(["2026-03-01"]);
    expect(second.nextBefore).toBeNull();
    expect((await get(started, "/api/reconciliations", ivan)).status).toBe(403);
    expect((await get(started, "/api/reconciliations", anvar)).status).toBe(403);
    expect((await get(started, "/api/reconciliations")).status).toBe(401);
    expect((await get(started, "/api/reconciliations?limit=0", owner)).status).toBe(400);
    expect((await get(started, "/api/reconciliations?before=yesterday", owner)).status).toBe(400);
  });

  it("brings what counting found into the totals of a period, so that they still add up", async () => {
    const { started, anvar, owner } = await workedDay();
    await reconcile(started, withId(counted(139_000, 7_500)), anvar);

    const day = async (from: string, to: string) =>
      (await (await get(started, `/api/summary?from=${from}&to=${to}`, owner)).json()).currencies[0] as Record<string, number>;
    const before = await day("2026-03-04", "2026-03-04");
    const during = await day("2026-03-05", "2026-03-05");
    const after = await day("2026-03-06", "2026-03-06");

    expect(before).toMatchObject({ openingMinor: 100_000, differenceMinor: 0, closingMinor: 100_000 });
    expect(during).toMatchObject({
      openingMinor: 100_000,
      incomeMinor: 50_000,
      expenseMinor: 10_000,
      handoverMinor: 0,
      differenceMinor: -1_000,
      closingMinor: 139_000,
    });
    expect(after).toMatchObject({ openingMinor: 139_000, differenceMinor: 0, closingMinor: 139_000 });
    for (const row of [before, during, after]) {
      expect(row.openingMinor! + row.incomeMinor! - row.expenseMinor! - row.handoverMinor! + row.differenceMinor!).toBe(row.closingMinor);
    }
  });

  it("holds the count in the database for good: it is never changed or deleted", async () => {
    const { started, anvar } = await workedDay();
    await reconcile(started, withId(counted(139_000, 7_500)), anvar);

    await expect(started.execute("UPDATE reconciliation_balances SET actual_minor = 1")).rejects.toThrow(/final/);
    await expect(started.execute("DELETE FROM reconciliations")).rejects.toThrow(/final/);
    await expect(started.execute("TRUNCATE reconciliation_balances")).rejects.toThrow(/final/);
  });
});
