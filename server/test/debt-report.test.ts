import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { importHistory, type HistoryFile } from "../src/admin/history.js";
import type { DebtReport } from "../src/debt-report.js";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Json = Record<string, unknown>;

/** The files of a ZIP by name, unpacked: enough to read a workbook the server made. */
function unzip(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = archive.readUInt32LE(end + 16);
  for (let left = archive.readUInt16LE(end + 10); left > 0; left--) {
    const packed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(archive.subarray(data, data + packed)).toString("utf8"));
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return files;
}

/** What the business read off its card file every evening: how the debts of its clients moved in the day, who owes most, who does not pay. */
describe("the report on the debts of a day", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const settings = { warehouses: parseWarehouses("andijan,kokand,tashkent"), kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), clientCodes: "digits" as const };

  /**
   * A small business in the middle of November: seven clients with what they owed at the start of the year, three
   * trucks that came on the 14th, the 15th and the 16th, and the payments of the year, as its card file had them.
   */
  const history = (): HistoryFile => ({
    clientCodes: "digits",
    clients: [
      { code: "1", name: "Улугбек", openingDebtMinor: 2_000_000 },
      { code: "2", name: "Захар", openingDebtMinor: 500_000 },
      // Never paid anything.
      { code: "3", name: "Рахим", openingDebtMinor: 90_000 },
      { code: "4", name: "Тимур", openingDebtMinor: 24_700 },
      { code: "5", name: "Марсел" },
      { code: "6", name: "Аброр", openingDebtMinor: 108_403 },
      { code: "7", name: "Саша", openingDebtMinor: 200_000 },
    ],
    trips: [
      { number: 245, arrivalDay: "2026-11-14", sums: [{ code: "1", amountMicro: 3_000_000_000 }] },
      { number: 246, arrivalDay: "2026-11-15", sums: [{ code: "5", amountMicro: 1_142_570_000 }, { code: "2", amountMicro: 500_000_000 }] },
      { number: 247, arrivalDay: "2026-11-16", sums: [{ code: "7", amountMicro: 800_000_000 }, { code: "1", amountMicro: 1_200_000_000 }] },
    ],
    payments: [
      { code: "1", day: "2026-01-05", amountMinor: 100_000, kassa: "moscow" },
      { code: "7", day: "2026-08-14", amountMinor: 50_000, kassa: "moscow" },
      { code: "6", day: "2026-10-17", amountMinor: 10_000, kassa: "andijan" },
      { code: "2", day: "2026-11-10", amountMinor: 30_000, kassa: "moscow" },
      { code: "1", day: "2026-11-16", amountMinor: 600_000, kassa: "tashkent" },
      { code: "4", day: "2026-11-16", amountMinor: 24_700, kassa: "moscow" },
      { code: "5", day: "2026-11-16", amountMinor: 114_300, kassa: "moscow" },
    ],
  });

  /** The business on the 17th of November, noon in Moscow, with the history of its card file loaded. */
  async function business() {
    const started = await startTestApp(settings);
    app = started;
    started.setNow(new Date("2026-11-17T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "sklad", password: "warehouse pass", role: "warehouse", displayName: "Завсклад" });
    const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 2 });
    try {
      await importHistory(pool, history(), settings);
    } finally {
      await pool.end();
    }
    return {
      started,
      mudir: await loginAs(started, "mudir", "admin password"),
      owner: await loginAs(started, "owner", "long enough pass"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      sklad: await loginAs(started, "sklad", "warehouse pass"),
    };
  }

  const report = async (started: TestApp, cookie: string, query = "") => {
    const answer = await get(started, `/api/debts/report${query}`, cookie);
    expect(answer.status, query).toBe(200);
    return (await answer.json()) as DebtReport;
  };
  const payment = (clientCode: string, amountMinor: number, more: Json = {}): Json => ({ id: randomUUID(), type: "income", amountMinor, currency: "USD", category: "client_payment", clientCode, ...more });

  it("says how the debt of all the clients moved in the day: what the trucks added, who paid and where, and what is worth a word", async () => {
    const { started, ivan } = await business();
    const day = await report(started, ivan, "?day=2026-11-16");
    expect(day).toMatchObject({
      day: "2026-11-16",
      since: "2026-11-15",
      historyFrom: "2026-01-01",
      primaryKassa: "moscow",
      openingMinor: 3_197_360,
      chargedMinor: 200_000,
      paidMinor: 739_000,
      closingMinor: 2_658_360,
      trips: [{ number: 247, day: "2026-11-16", amountMinor: 200_000, clients: 2 }],
      chargedClients: 2,
      // Tashkent took the payment of Улугбек: it takes his debt down, and it is no money of the main desk.
      paidElsewhere: [{ kassa: "tashkent", amountMinor: 600_000 }],
      // One day: nothing to tell day by day.
      days: [],
      refunds: [],
    });
    expect(day.payers).toEqual([
      { code: "1", name: "Улугбек", amountMinor: 600_000, kassas: ["tashkent"], debtMinor: 1_720_000, closed: false },
      // 1 143 for the 1 142,57 of the truck: 43 cents ahead, and nothing owed.
      { code: "5", name: "Марсел", amountMinor: 114_300, kassas: [], debtMinor: -43, closed: true },
      { code: "4", name: "Тимур", amountMinor: 24_700, kassas: [], debtMinor: 0, closed: true },
    ]);
    expect(day.charged).toEqual([
      { code: "1", name: "Улугбек", amountMinor: 120_000, trips: [247] },
      { code: "7", name: "Саша", amountMinor: 80_000, trips: [247] },
    ]);
    expect(day.events).toEqual({
      closed: [{ code: "4", name: "Тимур" }, { code: "5", name: "Марсел" }],
      // What the truck of the day before came to, paid the day after it came.
      paidTrip: [{ code: "5", name: "Марсел", trip: 246, amountMinor: 114_300, daysAfter: 1, closed: true }],
      // The first payment since January; the first ones ever.
      firstPayment: [
        { code: "1", name: "Улугбек", amountMinor: 600_000, previousDay: "2026-01-05" },
        { code: "5", name: "Марсел", amountMinor: 114_300, previousDay: null },
        { code: "4", name: "Тимур", amountMinor: 24_700, previousDay: null },
      ],
      crossed: null,
    });
    // No closing of the 15th was ever kept: nothing can be said of what was written into it later.
    expect(day.backdated).toBeNull();
  });

  it("lists those who owe most, with what the day changed and when each paid last", async () => {
    const { started, owner } = await business();
    const { debtors, top } = await report(started, owner, "?day=2026-11-16");
    // Whoever owes more than a dollar: the 43 cents Марсел is ahead by are in the debt of all, and he is no debtor.
    expect(debtors).toEqual({ count: 5, totalMinor: 2_658_403 });
    expect(top.totalMinor).toBe(2_658_403);
    expect(top.rows).toEqual([
      { place: 1, code: "1", name: "Улугбек", debtMinor: 1_720_000, changeMinor: -480_000, lastPaidDay: "2026-11-16", daysUnpaid: 0, isNew: false },
      { place: 2, code: "2", name: "Захар", debtMinor: 520_000, changeMinor: 0, lastPaidDay: "2026-11-10", daysUnpaid: 6, isNew: false },
      { place: 3, code: "7", name: "Саша", debtMinor: 230_000, changeMinor: 80_000, lastPaidDay: "2026-08-14", daysUnpaid: 94, isNew: false },
      { place: 4, code: "6", name: "Аброр", debtMinor: 98_403, changeMinor: 0, lastPaidDay: "2026-10-17", daysUnpaid: 30, isNew: false },
      // No payment at all: the days are counted from the first of January, where the history begins.
      { place: 5, code: "3", name: "Рахим", debtMinor: 90_000, changeMinor: 0, lastPaidDay: null, daysUnpaid: 319, isNew: false },
    ]);
    // Who is not in the list any more, and why: they paid.
    expect(top.left).toEqual([
      { code: "5", name: "Марсел", paidMinor: 114_300, debtMinor: -43, changeMinor: -114_300 },
      { code: "4", name: "Тимур", paidMinor: 24_700, debtMinor: 0, changeMinor: -24_700 },
    ]);
    expect(top).toMatchObject({ entered: [], moved: [], near: [], crossed: [{ code: "6", name: "Аброр", days: 30 }] });
  });

  it("lists those who owe over 500 $ and have not paid for thirty days and more, the new ones and the ones a truck still came for", async () => {
    const { started, owner, ivan } = await business();
    const { overdue } = await report(started, owner, "?day=2026-11-16");
    expect(overdue.rows).toEqual([
      // 94 days without a payment, and cargo on the truck of this very day.
      { code: "7", name: "Саша", debtMinor: 230_000, lastPaidDay: "2026-08-14", daysUnpaid: 94, lastTripDay: "2026-11-16", isNew: false, gotCargo: true },
      // Thirty days today: new in the list.
      { code: "6", name: "Аброр", debtMinor: 98_403, lastPaidDay: "2026-10-17", daysUnpaid: 30, lastTripDay: null, isNew: true, gotCargo: false },
      { code: "3", name: "Рахим", debtMinor: 90_000, lastPaidDay: null, daysUnpaid: 319, lastTripDay: null, isNew: false, gotCargo: false },
    ]);
    expect(overdue).toMatchObject({
      totalMinor: 418_403,
      long: 2,
      // Until the day before these two had not paid since January, and never: they paid, and are out of the list.
      left: [
        { code: "1", name: "Улугбек", paidMinor: 600_000, debtMinor: 1_720_000 },
        { code: "5", name: "Марсел", paidMinor: 114_300, debtMinor: -43 },
      ],
      came: [{ code: "6", name: "Аброр", debtMinor: 98_403, daysUnpaid: 30, lastPaidDay: "2026-10-17", reason: "days" }],
    });

    // The day after, Рахим pays for the first time: he is out of the list, and the report says what took him out.
    expect((await postJson(started, "/api/operations", payment("3", 50_000), ivan)).status).toBe(201);
    const next = (await report(started, owner)).overdue;
    expect(next.rows.map((row) => row.code)).toEqual(["7", "6"]);
    expect(next.left).toEqual([{ code: "3", name: "Рахим", paidMinor: 50_000, debtMinor: 40_000 }]);
    expect(next.came).toEqual([]);
  });

  it("has the control sheet of the year up to the day, and it comes to the debt of all to the cent", async () => {
    const { started, owner } = await business();
    const { control, closingMinor } = await report(started, owner, "?day=2026-11-16");
    expect(control.year).toBe(2026);
    expect(control.months.map((month) => month.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(control.months[0]).toEqual({ month: "2026-01", openingMinor: 2_923_103, chargedMinor: 0, paidMinor: 100_000, closingMinor: 2_823_103 });
    expect(control.months[10]).toEqual({ month: "2026-11", openingMinor: 2_763_103, chargedMinor: 664_257, paidMinor: 769_000, closingMinor: 2_658_360 });
    expect(control.months[10]!.closingMinor).toBe(closingMinor);
    expect(control.agrees).toBe(true);

    // Of an earlier day: the months up to it, and of its month only what had happened by then.
    const october = (await report(started, owner, "?day=2026-10-16")).control;
    expect(october.months).toHaveLength(10);
    expect(october.months[9]).toEqual({ month: "2026-10", openingMinor: 2_773_103, chargedMinor: 0, paidMinor: 0, closingMinor: 2_773_103 });
  });

  it("looks back on the whole month the day it ends, and on no other day", async () => {
    const { started, owner } = await business();
    expect((await report(started, owner, "?day=2026-11-16")).dynamics).toBeNull();
    expect((await report(started, owner, "?day=2026-10-30")).dynamics).toBeNull();
    const october = await report(started, owner, "?day=2026-10-31");
    const { dynamics } = october;
    expect(dynamics).toMatchObject({ month: "2026-10", openingMinor: 2_773_103, trips: 0 });
    expect(dynamics!.days).toHaveLength(31);
    expect(dynamics!.days[0]).toEqual({ day: "2026-10-01", chargedMinor: 0, paidMinor: 0, closingMinor: 2_773_103 });
    // The one payment of the month, on the 17th.
    expect(dynamics!.days[16]).toEqual({ day: "2026-10-17", chargedMinor: 0, paidMinor: 10_000, closingMinor: 2_763_103 });
    expect(dynamics!.days[30]).toEqual({ day: "2026-10-31", chargedMinor: 0, paidMinor: 0, closingMinor: october.closingMinor });

    // November ends on the 30th: three trucks came in it, and the days add up to what the month ends with.
    started.setNow(new Date("2026-11-30T09:00:00Z"));
    const november = await report(started, owner, "?day=2026-11-30");
    expect(november.dynamics).toMatchObject({ month: "2026-11", openingMinor: 2_763_103, trips: 3 });
    expect(november.dynamics!.days).toHaveLength(30);
    expect(november.dynamics!.days[13]).toEqual({ day: "2026-11-14", chargedMinor: 300_000, paidMinor: 0, closingMinor: 3_033_103 });
    expect(november.dynamics!.days[15]).toEqual({ day: "2026-11-16", chargedMinor: 200_000, paidMinor: 739_000, closingMinor: 2_658_360 });
    expect(november.dynamics!.days[29]!.closingMinor).toBe(november.control.months[10]!.closingMinor);
  });

  it("covers several days when it is compared with an earlier closing, and tells them one by one", async () => {
    const { started, ivan } = await business();
    const days = await report(started, ivan, "?day=2026-11-16&since=2026-11-13");
    expect(days).toMatchObject({ since: "2026-11-13", openingMinor: 2_733_103, chargedMinor: 664_257, paidMinor: 739_000, closingMinor: 2_658_360, chargedClients: 4 });
    expect(days.trips.map((trip) => [trip.number, trip.day, trip.amountMinor, trip.clients])).toEqual([
      [245, "2026-11-14", 300_000, 1],
      [246, "2026-11-15", 164_257, 2],
      [247, "2026-11-16", 200_000, 2],
    ]);
    expect(days.days).toEqual([
      { day: "2026-11-14", trips: [{ number: 245, amountMinor: 300_000 }], chargedMinor: 300_000, paidMinor: 0, closingMinor: 3_033_103 },
      { day: "2026-11-15", trips: [{ number: 246, amountMinor: 164_257 }], chargedMinor: 164_257, paidMinor: 0, closingMinor: 3_197_360 },
      { day: "2026-11-16", trips: [{ number: 247, amountMinor: 200_000 }], chargedMinor: 200_000, paidMinor: 739_000, closingMinor: 2_658_360 },
    ]);
    // Улугбек: two trucks in the period.
    expect(days.charged[0]).toEqual({ code: "1", name: "Улугбек", amountMinor: 420_000, trips: [245, 247] });
    // Марсел came into the list with the truck of the 15th and paid it off on the 16th: neither new nor gone, over the three days.
    expect(days.top.rows.map((row) => row.code)).toEqual(["1", "2", "7", "6", "3"]);
    expect(days.top.left).toEqual([{ code: "4", name: "Тимур", paidMinor: 24_700, debtMinor: 0, changeMinor: -24_700 }]);
  });

  it("counts what the cash desks take from today on, with the desk that took it", async () => {
    const { started, ivan, mudir, owner } = await business();
    expect((await postJson(started, "/api/operations", payment("2 Захар", 120_000), ivan)).status).toBe(201);
    expect((await postJson(started, "/api/operations", payment("7", 30_000, { kassa: "andijan" }), mudir)).status).toBe(201);
    // Money given back to a client is a payment of less than nothing.
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 5_000, currency: "USD", category: "client_refund", clientCode: "3" }, ivan)).status).toBe(201);
    // Without a day: today's, compared with yesterday.
    const today = await report(started, owner);
    expect(today).toMatchObject({ day: "2026-11-17", since: "2026-11-16", openingMinor: 2_658_360, chargedMinor: 0, paidMinor: 145_000, closingMinor: 2_513_360, trips: [], paidElsewhere: [{ kassa: "andijan", amountMinor: 30_000 }] });
    expect(today.payers).toEqual([
      { code: "2", name: "Захар", amountMinor: 120_000, kassas: [], debtMinor: 400_000, closed: false },
      { code: "7", name: "Саша", amountMinor: 30_000, kassas: ["andijan"], debtMinor: 200_000, closed: false },
    ]);
    expect(today.refunds).toEqual([{ code: "3", name: "Рахим", amountMinor: 5_000 }]);
    // Саша paid after 94 days: the first payment since August.
    expect(today.events.firstPayment).toEqual([{ code: "7", name: "Саша", amountMinor: 30_000, previousDay: "2026-08-14" }]);
    expect(today.overdue.left).toEqual([{ code: "7", name: "Саша", paidMinor: 30_000, debtMinor: 200_000 }]);
  });

  it("keeps what everybody owed when a day closed, and says what was written into the closed days afterwards", async () => {
    const { started, ivan, mudir, owner, sklad } = await business();
    // The 17th: a payment of Захар. Looking at the report closes the 16th, the day that is over.
    const paid = payment("2", 30_000);
    expect((await postJson(started, "/api/operations", paid, ivan)).status).toBe(201);
    const first = await report(started, owner);
    expect(first.backdated).toMatchObject({ thenMinor: 2_658_360, changes: [], trips: [], topIn: [], topOut: [], overdueIn: [], overdueOut: [] });
    expect(first.backdated!.takenAt).toBe("2026-11-17T09:00:00.000Z");

    // The 18th: the 17th closes by itself, with the debt it ended with.
    started.setNow(new Date("2026-11-18T10:00:00Z"));
    const second = await report(started, owner);
    expect(second).toMatchObject({ day: "2026-11-18", since: "2026-11-17", openingMinor: 2_628_360, closingMinor: 2_628_360 });
    expect(second.backdated).toMatchObject({ thenMinor: 2_628_360, changes: [] });

    // Then the past is written into. The payment of yesterday was of Рахим, not of Захар: the admin corrects it.
    started.setNow(new Date("2026-11-18T11:00:00Z"));
    expect((await putJson(started, `/api/operations/${paid.id as string}`, { type: "income", amountMinor: 30_000, currency: "USD", category: "client_payment", clientCode: "3", reason: "не тот клиент" }, mudir)).status).toBe(200);
    const moved = await report(started, owner);
    // The debt of all on the 17th is what it was; two clients owe something else.
    expect(moved.openingMinor).toBe(2_628_360);
    expect(moved.backdated).toMatchObject({
      thenMinor: 2_628_360,
      changes: [
        { code: "2", name: "Захар", changeMinor: 30_000 },
        { code: "3", name: "Рахим", changeMinor: -30_000 },
      ],
      trips: [],
    });

    // A truck that came yesterday is marked as arrived only today: 100 kg of Тимур at 6 $.
    expect((await postJson(started, "/api/trips", { number: 252, departureDay: "2026-11-10" }, sklad)).status).toBe(201);
    expect((await postJson(started, "/api/trips/252/cargo", { id: randomUUID(), warehouse: "andijan", clientCode: "4", weightG: 100_000, priceMilli: 6000 }, sklad)).status).toBe(201);
    expect((await postJson(started, "/api/trips/252/status", { status: "in_transit" }, sklad)).status).toBe(200);
    expect((await postJson(started, "/api/trips/252/status", { status: "arrived", arrivalDay: "2026-11-17" }, sklad)).status).toBe(200);
    const late = await report(started, owner);
    // The tile of the 17th shows what that day comes to now, not what was kept.
    expect(late.openingMinor).toBe(2_688_360);
    expect(late.backdated).toMatchObject({
      thenMinor: 2_628_360,
      changes: [
        { code: "4", name: "Тимур", changeMinor: 60_000 },
        { code: "2", name: "Захар", changeMinor: 30_000 },
        { code: "3", name: "Рахим", changeMinor: -30_000 },
      ],
      trips: [{ number: 252, day: "2026-11-17", amountMinor: 60_000, clients: 1 }],
      // With the truck Тимур is among those who owe most on the 17th; with the payment that is his now, Рахим is no
      // longer among those who do not pay.
      topIn: [{ code: "4", name: "Тимур" }],
      topOut: [],
      overdueIn: [],
      overdueOut: [{ code: "3", name: "Рахим" }],
    });
    // The truck is no charge of today: it is in the day it came.
    expect(late).toMatchObject({ chargedMinor: 0, trips: [] });

    // A deleted entry of a closed day is told the same way.
    expect((await deleteRequest(started, `/api/operations/${paid.id as string}`, mudir, { reason: "ошибка" })).status).toBe(200);
    expect((await report(started, owner)).backdated!.changes).toEqual([
      { code: "4", name: "Тимур", changeMinor: 60_000 },
      { code: "2", name: "Захар", changeMinor: 30_000 },
    ]);

    // What was kept stays as it was taken, whoever asks the database.
    await expect(started.execute("UPDATE debt_closings SET total_minor = 0")).rejects.toThrow(/kept as it was taken/);
  });

  it("closes every day the server slept through when it is back, and none of before it was first asked", async () => {
    const { started, owner } = await business();
    await report(started, owner);
    // Four days later: the 17th, the 18th, the 19th and the 20th have closed.
    started.setNow(new Date("2026-11-21T09:00:00Z"));
    for (const since of ["2026-11-16", "2026-11-17", "2026-11-19", "2026-11-20"]) expect((await report(started, owner, `?since=${since}`)).backdated, since).not.toBeNull();
    // The 15th closed long before anybody looked.
    expect((await report(started, owner, "?since=2026-11-15")).backdated).toBeNull();
    // A night in Moscow belongs to the day that is ending: at half past two the 21st is still on.
    started.setNow(new Date("2026-11-21T23:30:00Z"));
    expect((await report(started, owner)).day).toBe("2026-11-21");
    started.setNow(new Date("2026-11-22T00:30:00Z"));
    expect((await report(started, owner)).day).toBe("2026-11-22");
  });

  it("is for the cashiers, the admin and the owner; not for the keeper of a warehouse, and not where no trips are kept", async () => {
    const { started, ivan, mudir, owner, sklad } = await business();
    for (const cookie of [ivan, mudir, owner]) expect((await get(started, "/api/debts/report", cookie)).status).toBe(200);
    for (const path of ["/api/debts/report", "/api/debts/unpaid.xlsx"]) {
      expect((await get(started, path, sklad)).status, path).toBe(403);
      expect((await get(started, path)).status, path).toBe(401);
    }
    // A day that has not come, a day that is none, a period that is none or too long.
    const refused: Array<[string, string | undefined]> = [
      ["?day=2026-11-18", "bad_day"],
      ["?day=2026-02-30", "bad_day"],
      ["?day=2026-11-16&since=2026-11-16", "bad_period"],
      ["?day=2026-11-16&since=2026-11-17", "bad_period"],
      ["?day=2026-11-16&since=2026-08-01", "bad_period"],
      ["?day=16.11.2026", undefined],
      ["?other=1", undefined],
    ];
    for (const [query, error] of refused) {
      const answer = await get(started, `/api/debts/report${query}`, owner);
      expect(answer.status, query).toBe(400);
      if (error) expect(await answer.json(), query).toEqual({ error });
    }
    expect(await (await get(started, "/api/debts/unpaid.xlsx?day=2026-11-18", owner)).json()).toEqual({ error: "bad_day" });

    await app!.close();
    const plain = await startTestApp();
    app = plain;
    await plain.admin.createUser({ login: "mudir", password: "admin password", role: "admin" });
    const admin = await loginAs(plain, "mudir", "admin password");
    for (const path of ["/api/debts/report", "/api/debts/unpaid.xlsx"]) {
      const answer = await get(plain, path, admin);
      expect(answer.status, path).toBe(404);
      expect(await answer.json()).toEqual({ error: "trips_disabled" });
    }
  });

  it("gives out the sheet of those who have not paid for over a week as a workbook of Excel", async () => {
    const { started, ivan, mudir } = await business();
    started.setNow(new Date("2026-11-18T09:00:00Z"));
    expect((await patchJson(started, "/api/admin/clients/7", { phone: "+7 900 000-00-07" }, mudir)).status).toBe(200);
    const answer = await get(started, "/api/debts/unpaid.xlsx?day=2026-11-18", ivan);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="unpaid-2026-11-18.xlsx"');
    const files = unzip(Buffer.from(await answer.arrayBuffer()));
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    expect(files.get("xl/workbook.xml")).toContain('<sheet name="Не платят 7+ дней" sheetId="1" r:id="rId1"/>');
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    const texts = [...sheet.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((found) => found[1]);
    expect(texts.slice(0, 12)).toEqual(["№", "Клиент", "Код", "Телефон", "Долг $", "Последняя оплата", "Сумма посл. оплаты", "Дней без оплаты", "Последний рейс", "Дата рейса", "Сумма по рейсу", "Оплачено в 2026"]);
    // Biggest debt first; whoever paid within the week (Улугбек, on the 16th) is not in it, whoever owes nothing neither.
    expect(texts.slice(12)).toEqual(["Захар", "2", "Саша", "7", "+7 900 000-00-07", "Аброр", "6", "Рахим", "3", "нет", "Итого на 18.11.2026: 4"]);
    // Захар: 5 200 $, paid 300 on the 10th of November (a date of Excel), eight days ago: yellow; the truck 246 of the 15th, 500 $.
    expect(sheet).toContain('<c r="E2" s="2"><v>5200</v></c><c r="F2" s="3"><v>46336</v></c><c r="G2" s="2"><v>300</v></c><c r="H2" s="5"><v>8</v></c><c r="I2" s="4"><v>246</v></c><c r="J2" s="3"><v>46341</v></c><c r="K2" s="2"><v>500</v></c><c r="L2" s="2"><v>300</v></c>');
    // 96 days: red; 32: orange.
    expect(sheet).toContain('<c r="H3" s="7"><v>96</v></c>');
    expect(sheet).toContain('<c r="H4" s="6"><v>32</v></c>');
    expect(sheet).toContain('<c r="H5" s="7"><v>321</v></c>');
    // The totals add up what the filter shows; the filter is over the four rows, not over the totals.
    expect(sheet).toContain('<c r="E6" s="9"><f>SUBTOTAL(109,E2:E5)</f><v>9384.03</v></c>');
    expect(sheet).toContain('<autoFilter ref="A1:L5"/>');
  });
});
