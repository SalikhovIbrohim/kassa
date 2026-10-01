import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

const OPENED = new Date("2026-03-05T08:30:00Z");
const CLOSED = new Date("2026-03-05T15:00:00Z");

type Entry = Record<string, unknown>;

describe("closing a shift with a count of the cash", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two cashiers and the owner; opening balances 1 000,00 RUB and 50,00 USD. */
  async function desk() {
    const started = await startTestApp();
    app = started;
    started.setNow(OPENED);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "1000");
    await started.admin.setOpeningBalance("USD", "50");
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });
  const counted = (rub: number, usd: number) => ({ counted: [{ currency: "RUB", amountMinor: rub }, { currency: "USD", amountMinor: usd }] });
  const close = (started: TestApp, id: string, body: unknown, cookie?: string) => postJson(started, `/api/shifts/${id}/close`, body, cookie);

  /** Ivan opens a shift and enters 500,00 in, 100,00 out in rubles and 20,00 in dollars: the books say 1 400,00 and 70,00. */
  async function workedShift() {
    const d = await desk();
    const { shift } = await (await postJson(d.started, "/api/shifts", {}, d.ivan)).json();
    await postJson(d.started, "/api/operations", income({ amountMinor: 50_000 }), d.ivan);
    await postJson(d.started, "/api/operations", expense({ amountMinor: 10_000 }), d.ivan);
    await postJson(d.started, "/api/operations", income({ amountMinor: 2_000, currency: "USD" }), d.ivan);
    d.started.setNow(CLOSED);
    return { ...d, shift: shift as { id: string } };
  }

  it("keeps, per currency, what the books said, what was counted and the difference, in the name of the cashier", async () => {
    const { started, ivan, shift } = await workedShift();

    const response = await close(started, shift.id, counted(139_000, 7_500), ivan);

    expect(response.status).toBe(200);
    expect((await response.json()).shift).toEqual({
      id: shift.id,
      openedAt: "2026-03-05T08:30:00.000Z",
      closedAt: "2026-03-05T15:00:00.000Z",
      cashier: { login: "ivan", displayName: "Иван" },
      closedBy: { login: "ivan", displayName: "Иван" },
      averageRateE4: 790_000,
      currencies: [
        { currency: "RUB", openingMinor: 100_000, calculatedMinor: 140_000, actualMinor: 139_000, differenceMinor: -1_000 },
        { currency: "USD", openingMinor: 5_000, calculatedMinor: 7_000, actualMinor: 7_500, differenceMinor: 500 },
      ],
    });
  });

  it("finds no difference when the count agrees with the books", async () => {
    const { started, ivan, shift } = await workedShift();

    const { shift: closed } = await (await close(started, shift.id, counted(140_000, 7_000), ivan)).json();

    expect(closed.currencies.map((item: { differenceMinor: number }) => item.differenceMinor)).toEqual([0, 0]);
  });

  it("makes the books say what was counted, and starts the next shift from it", async () => {
    const { started, ivan, shift } = await workedShift();

    await close(started, shift.id, counted(139_000, 7_500), ivan);

    expect(await (await get(started, "/api/balances", ivan)).json()).toEqual({
      balances: [
        { currency: "RUB", amountMinor: 139_000 },
        { currency: "USD", amountMinor: 7_500 },
      ],
    });
    expect(await (await get(started, "/api/shifts/current", ivan)).json()).toEqual({ shift: null });
    const next = await (await postJson(started, "/api/shifts", {}, ivan)).json();
    expect(next.shift.openingBalances).toEqual([
      { currency: "RUB", amountMinor: 139_000 },
      { currency: "USD", amountMinor: 7_500 },
    ]);
  });

  it("takes an expense above what was counted: the balance goes below zero", async () => {
    const { started, ivan, shift } = await workedShift();
    await close(started, shift.id, counted(139_000, 7_500), ivan);

    const tooMuch = await postJson(started, "/api/operations", expense({ amountMinor: 139_001 }), ivan);

    expect(tooMuch.status).toBe(201);
    expect((await tooMuch.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: -1 });
  });

  it("counts against everything the books hold, also what another cashier entered while this shift was open", async () => {
    const { started, ivan, petr, shift } = await workedShift();
    // Petr's entry belongs to no shift, but the money is in the cash desk all the same.
    await postJson(started, "/api/operations", income({ amountMinor: 30_000 }), petr);

    const { shift: closed } = await (await close(started, shift.id, counted(170_000, 7_000), ivan)).json();

    expect(closed.currencies[0]).toMatchObject({ calculatedMinor: 170_000, actualMinor: 170_000, differenceMinor: 0 });
  });

  it("refuses what is not a count of both currencies", async () => {
    const { started, ivan, shift } = await workedShift();
    const bad: unknown[] = [
      {},
      { counted: [] },
      { counted: [{ currency: "RUB", amountMinor: 1 }] },
      { counted: [{ currency: "RUB", amountMinor: 1 }, { currency: "RUB", amountMinor: 2 }] },
      { counted: [{ currency: "RUB", amountMinor: -1 }, { currency: "USD", amountMinor: 0 }] },
      { counted: [{ currency: "RUB", amountMinor: 1.5 }, { currency: "USD", amountMinor: 0 }] },
      { counted: [{ currency: "EUR", amountMinor: 1 }, { currency: "USD", amountMinor: 0 }] },
      { counted: [{ currency: "RUB", amountMinor: "100" }, { currency: "USD", amountMinor: 0 }] },
      { ...counted(1, 1), extra: true },
    ];

    for (const body of bad) expect((await close(started, shift.id, body, ivan)).status, JSON.stringify(body)).toBe(400);

    // Nothing was closed by any of them; an empty cash desk is a count too.
    expect((await get(started, "/api/shifts/current", ivan).then((r) => r.json())).shift).not.toBeNull();
    expect((await close(started, shift.id, counted(0, 0), ivan)).status).toBe(200);
  });

  it("is for the cashier whose shift it is: nobody else, and nobody without a session", async () => {
    const { started, ivan, petr, owner, shift } = await workedShift();

    expect((await close(started, shift.id, counted(1, 1), owner)).status).toBe(403);
    const other = await close(started, shift.id, counted(1, 1), petr);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: "not_your_shift" });
    expect((await close(started, shift.id, counted(1, 1))).status).toBe(401);
    expect((await close(started, randomUUID(), counted(1, 1), ivan)).status).toBe(404);
    expect((await close(started, "not-an-id", counted(1, 1), ivan)).status).toBe(400);
    expect((await get(started, "/api/shifts/current", ivan).then((r) => r.json())).shift).toMatchObject({ id: shift.id });
  });

  it("answers a second closing with the same count as the first, and refuses another count", async () => {
    const { started, ivan, shift } = await workedShift();
    const first = await (await close(started, shift.id, counted(139_000, 7_500), ivan)).json();
    started.setNow(new Date("2026-03-05T16:00:00Z"));

    const same = await close(started, shift.id, counted(139_000, 7_500), ivan);
    const other = await close(started, shift.id, counted(100_000, 7_500), ivan);

    expect(same.status).toBe(200);
    expect(await same.json()).toEqual(first);
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: "shift_already_closed", shift: first.shift });
    // The books were not changed by either.
    expect((await (await get(started, "/api/balances", ivan)).json()).balances[0].amountMinor).toBe(139_000);
  });

  it("lists the shifts for the owner, newest first, with how the counts came out; an open one has no count yet", async () => {
    const { started, ivan, petr, owner, shift } = await workedShift();
    await close(started, shift.id, counted(139_000, 7_500), ivan);
    started.setNow(new Date("2026-03-06T08:00:00Z"));
    const second = (await (await postJson(started, "/api/shifts", {}, petr)).json()).shift;

    const response = await get(started, "/api/shifts", owner);

    expect(response.status).toBe(200);
    const { shifts, nextBefore } = await response.json();
    expect(nextBefore).toBeNull();
    expect(shifts.map((item: { id: string }) => item.id)).toEqual([second.id, shift.id]);
    expect(shifts[0]).toMatchObject({ closedAt: null, closedBy: null, cashier: { login: "petr" } });
    expect(shifts[0].currencies).toEqual([
      { currency: "RUB", openingMinor: 139_000, calculatedMinor: null, actualMinor: null, differenceMinor: null },
      { currency: "USD", openingMinor: 7_500, calculatedMinor: null, actualMinor: null, differenceMinor: null },
    ]);
    expect(shifts[1].currencies[0]).toMatchObject({ differenceMinor: -1_000 });
  });

  it("pages through the shifts, and keeps the list from cashiers and from strangers", async () => {
    const { started, ivan, owner } = await desk();
    for (const day of ["01", "02", "03"]) {
      started.setNow(new Date(`2026-03-${day}T08:00:00Z`));
      const { shift } = await (await postJson(started, "/api/shifts", {}, ivan)).json();
      started.setNow(new Date(`2026-03-${day}T16:00:00Z`));
      await close(started, shift.id, counted(100_000, 5_000), ivan);
    }

    const first = await (await get(started, "/api/shifts?limit=2", owner)).json();
    const second = await (await get(started, `/api/shifts?limit=2&before=${encodeURIComponent(first.nextBefore)}`, owner)).json();

    expect(first.shifts.map((item: { openedAt: string }) => item.openedAt.slice(0, 10))).toEqual(["2026-03-03", "2026-03-02"]);
    expect(second.shifts.map((item: { openedAt: string }) => item.openedAt.slice(0, 10))).toEqual(["2026-03-01"]);
    expect(second.nextBefore).toBeNull();
    expect((await get(started, "/api/shifts", ivan)).status).toBe(403);
    expect((await get(started, "/api/shifts")).status).toBe(401);
    expect((await get(started, "/api/shifts?limit=0", owner)).status).toBe(400);
    expect((await get(started, "/api/shifts?before=yesterday", owner)).status).toBe(400);
  });

  it("brings what counting found into the totals of a period, so that they still add up", async () => {
    const { started, ivan, owner, shift } = await workedShift();
    await close(started, shift.id, counted(139_000, 7_500), ivan);

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
});
