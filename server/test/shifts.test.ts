import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const NOW = new Date("2026-03-05T08:30:00Z");
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry = Record<string, unknown>;

describe("shifts: opening, and what belongs to one", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two cashiers and the owner; opening balances 1 000,00 RUB and 50,00 USD. */
  async function desk() {
    const started = await startTestApp();
    app = started;
    started.setNow(NOW);
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

  const income = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });

  /**
   * A shift that was closed and counted. Closing a shift is a later ticket, so the table is written to
   * directly: the public API cannot produce this yet.
   */
  async function closedShift(started: TestApp, cashier: string, closedAt: string, counted: { RUB: number; USD: number }) {
    const id = randomUUID();
    await started.execute(
      "INSERT INTO shifts (id, cashier_id, opened_at, closed_at, closed_by) VALUES ($1, (SELECT id FROM users WHERE login = $2), $3::timestamptz - interval '8 hours', $3, (SELECT id FROM users WHERE login = $2))",
      [id, cashier, closedAt],
    );
    for (const [currency, actual] of Object.entries(counted)) {
      await started.execute(
        "INSERT INTO shift_balances (shift_id, currency, opening_minor, calculated_minor, actual_minor, difference_minor) VALUES ($1, $2, 0, $3, $3, 0)",
        [id, currency, actual],
      );
    }
    return id;
  }

  const open = (started: TestApp, cookie?: string) => postJson(started, "/api/shifts", {}, cookie);
  const current = async (started: TestApp, cookie: string) => (await (await get(started, "/api/shifts/current", cookie)).json()).shift;

  it("has no open shift at first", async () => {
    const { started, ivan } = await desk();

    const response = await get(started, "/api/shifts/current", ivan);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shift: null });
  });

  it("opens a shift for the cashier, with the balances of that moment as its opening balances", async () => {
    const { started, ivan } = await desk();
    expect((await postJson(started, "/api/operations", income({ amountMinor: 50_000 }), ivan)).status).toBe(201);
    expect((await postJson(started, "/api/operations", expense({ amountMinor: 20_000 }), ivan)).status).toBe(201);

    const response = await open(started, ivan);

    expect(response.status).toBe(201);
    const { shift } = await response.json();
    expect(shift).toEqual({
      id: expect.stringMatching(UUID_SHAPE),
      openedAt: "2026-03-05T08:30:00.000Z",
      cashier: { login: "ivan", displayName: "Иван" },
      openingBalances: [
        { currency: "RUB", amountMinor: 130_000 },
        { currency: "USD", amountMinor: 5_000 },
      ],
    });
    expect(await current(started, ivan)).toEqual(shift);
  });

  it("refuses a second shift while one is open, and says whose it is and since when", async () => {
    const { started, ivan, petr } = await desk();
    const first = (await (await open(started, ivan)).json()).shift;

    const byOther = await open(started, petr);
    const byOwner = await open(started, ivan);

    for (const response of [byOther, byOwner]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "shift_already_open", shift: { id: first.id, cashier: { login: "ivan" }, openedAt: "2026-03-05T08:30:00.000Z" } });
    }
    expect(await current(started, petr)).toMatchObject({ id: first.id });
  });

  it("lets exactly one of two cashiers who open a shift at the same moment succeed", async () => {
    const { started, ivan, petr } = await desk();

    const [a, b] = await Promise.all([open(started, ivan), open(started, petr)]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? "ivan" : "petr";
    expect(await current(started, ivan)).toMatchObject({ cashier: { login: winner } });
    const shifts = await started.query("SELECT id FROM shifts");
    expect(shifts).toHaveLength(1);
  });

  it("is for cashiers to open; the owner may only look, and nobody without a session may do either", async () => {
    const { started, owner } = await desk();

    expect((await open(started, owner)).status).toBe(403);
    expect((await open(started)).status).toBe(401);
    expect((await get(started, "/api/shifts/current")).status).toBe(401);
    expect((await get(started, "/api/shifts/current", owner)).status).toBe(200);
  });

  it("starts the next shift with what was counted at the end of the one before, not with what the books say", async () => {
    const { started, ivan } = await desk();
    await closedShift(started, "petr", "2026-03-04T15:00:00Z", { RUB: 90_000, USD: 4_000 });
    // The latest closed one counts, whatever order they were written in.
    await closedShift(started, "ivan", "2026-03-05T05:00:00Z", { RUB: 98_000, USD: 5_500 });
    await closedShift(started, "petr", "2026-03-03T15:00:00Z", { RUB: 1, USD: 1 });

    const { shift } = await (await open(started, ivan)).json();

    expect(shift.openingBalances).toEqual([
      { currency: "RUB", amountMinor: 98_000 },
      { currency: "USD", amountMinor: 5_500 },
    ]);
    // The books themselves are untouched by shifts.
    expect(await (await get(started, "/api/balances", ivan)).json()).toEqual({
      balances: [
        { currency: "RUB", amountMinor: 100_000 },
        { currency: "USD", amountMinor: 5_000 },
      ],
    });
  });

  it("puts an operation of the cashier who has the shift open into it, and the journal of the shift shows it", async () => {
    const { started, ivan } = await desk();
    const { shift } = await (await open(started, ivan)).json();
    const body = income({ amountMinor: 70_000 });

    const response = await postJson(started, "/api/operations", body, ivan);

    expect(response.status).toBe(201);
    expect((await response.json()).operation).toMatchObject({ id: body.id, shiftId: shift.id });
    const journal = await (await get(started, "/api/operations?shift=current", ivan)).json();
    expect(journal.operations.map((item: { id: string }) => item.id)).toEqual([body.id]);
  });

  it("leaves an operation of another cashier out of a shift that is not theirs", async () => {
    const { started, ivan, petr } = await desk();
    const { shift } = await (await open(started, ivan)).json();
    const mine = income();
    const theirs = income();
    await postJson(started, "/api/operations", mine, ivan);

    const response = await postJson(started, "/api/operations", theirs, petr);

    expect(response.status).toBe(201);
    expect((await response.json()).operation.shiftId).toBeNull();
    const journalOfIvan = await (await get(started, "/api/operations?shift=current", ivan)).json();
    expect(journalOfIvan.operations.map((item: { id: string }) => item.id)).toEqual([mine.id]);
    expect((await (await get(started, "/api/operations?shift=current", petr)).json()).operations).toEqual([]);
    expect((await current(started, petr)).id).toBe(shift.id);
  });

  it("keeps the operations from before there were shifts as they are, and opening a shift changes no balance", async () => {
    const { started, ivan, owner } = await desk();
    const before = income({ amountMinor: 33_000 });
    await postJson(started, "/api/operations", before, ivan);
    await postJson(started, "/api/operations", expense({ amountMinor: 3_000 }), ivan);
    const balancesBefore = await (await get(started, "/api/balances", ivan)).json();

    await open(started, ivan);

    expect(await (await get(started, "/api/balances", ivan)).json()).toEqual(balancesBefore);
    const journal = await (await get(started, "/api/operations", owner)).json();
    expect(journal.operations).toHaveLength(2);
    expect(journal.operations.every((item: { shiftId: string | null }) => item.shiftId === null)).toBe(true);
  });

  it("still takes an entry when no shift is open, and the entry belongs to no shift", async () => {
    const { started, ivan } = await desk();
    const body = income();

    const response = await postJson(started, "/api/operations", body, ivan);

    expect(response.status).toBe(201);
    expect((await response.json()).operation.shiftId).toBeNull();
  });

  it("puts an entry made without a connection into the shift the phone says was open, also when it has been closed since", async () => {
    const { started, ivan } = await desk();
    const { shift } = await (await open(started, ivan)).json();
    await started.execute(
      "UPDATE shifts SET closed_at = $2, closed_by = cashier_id WHERE id = $1",
      [shift.id, "2026-03-05T09:00:00Z"],
    );
    await started.execute("UPDATE shift_balances SET calculated_minor = opening_minor, actual_minor = opening_minor, difference_minor = 0 WHERE shift_id = $1", [shift.id]);
    const late = income({ shiftId: shift.id });

    const response = await postJson(started, "/api/operations", late, ivan);

    expect(response.status).toBe(201);
    expect((await response.json()).operation.shiftId).toBe(shift.id);
    // Sent again, it is the same entry in the same shift, also with a newer shift open by now.
    await open(started, ivan);
    const again = await postJson(started, "/api/operations", late, ivan);
    expect(again.status).toBe(200);
    expect((await again.json()).operation.shiftId).toBe(shift.id);
  });

  it("does not put an entry into a shift that is not the author's or does not exist: it goes to the author's open shift, or to none", async () => {
    const { started, ivan, petr } = await desk();
    const { shift } = await (await open(started, ivan)).json();
    const ofPetr = await closedShift(started, "petr", "2026-03-04T15:00:00Z", { RUB: 0, USD: 0 });

    const foreign = await postJson(started, "/api/operations", income({ shiftId: ofPetr }), ivan);
    const unknown = await postJson(started, "/api/operations", income({ shiftId: randomUUID() }), ivan);
    const notMine = await postJson(started, "/api/operations", income({ shiftId: shift.id }), petr);

    expect((await foreign.json()).operation.shiftId).toBe(shift.id);
    expect((await unknown.json()).operation.shiftId).toBe(shift.id);
    expect(notMine.status).toBe(201);
    expect((await notMine.json()).operation.shiftId).toBeNull();
  });

  it("shows the owner the operations of a shift, whatever day they were made on", async () => {
    const { started, ivan, owner } = await desk();
    // 23:00 in Moscow on the 5th is 20:00 UTC.
    started.setNow(new Date("2026-03-05T20:00:00Z"));
    const { shift } = await (await open(started, ivan)).json();
    const evening = income({ amountMinor: 10_000 });
    await postJson(started, "/api/operations", evening, ivan);
    // Two hours later it is the 6th in Moscow.
    started.setNow(new Date("2026-03-05T22:00:00Z"));
    const night = income({ amountMinor: 20_000 });
    await postJson(started, "/api/operations", night, ivan);
    started.setNow(new Date("2026-03-06T08:00:00Z"));

    const ofShift = await (await get(started, `/api/operations?shift=${shift.id}`, owner)).json();
    const ofToday = await (await get(started, "/api/operations", owner)).json();
    const ofShiftToday = await (await get(started, `/api/operations?shift=current&from=2026-03-06&to=2026-03-06`, owner)).json();

    expect(ofShift.operations.map((item: { id: string }) => item.id)).toEqual([night.id, evening.id]);
    expect(ofToday.operations.map((item: { id: string }) => item.id)).toEqual([night.id]);
    expect(ofShiftToday.operations.map((item: { id: string }) => item.id)).toEqual([night.id]);
  });

  it("answers an empty journal for 'the current shift' when none is open, and refuses what is not a shift", async () => {
    const { started, ivan } = await desk();
    await postJson(started, "/api/operations", income(), ivan);

    const none = await get(started, "/api/operations?shift=current", ivan);
    const bad = await get(started, "/api/operations?shift=yesterday", ivan);

    expect(none.status).toBe(200);
    expect((await none.json()).operations).toEqual([]);
    expect(bad.status).toBe(400);
  });
});
