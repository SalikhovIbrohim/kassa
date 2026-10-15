import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cashDayStart } from "../src/cash-day.js";
import { deleteRequest, loginAs, postJson, putJson } from "./helpers/http.js";
import { startFakeGoogle, type FakeGoogle } from "./helpers/fake-google.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Entry = Record<string, unknown>;

/** The journal copied to a Google spreadsheet: a row per entry, written again when the entry is corrected or deleted. */
describe("the journal in a Google spreadsheet", () => {
  let app: TestApp | undefined;
  let google: FakeGoogle;

  beforeEach(async () => {
    google = await startFakeGoogle();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await google.close();
  });

  async function desk(from?: string) {
    const started = await startTestApp({
      sheet: google.settings({ from: from ? cashDayStart(from) : undefined }),
      sheetQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
    });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Хожиакбар" });
    return { started, ivan: await loginAs(started, "ivan", "correct horse") };
  }

  const payment = (overrides: Entry = {}): Entry => ({
    id: randomUUID(),
    type: "income",
    amountMinor: 8_655_000,
    currency: "RUB",
    rateE4: 865_500,
    category: "client_payment",
    clientCode: "A412 Лочинбек",
    ...overrides,
  });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 130_000, currency: "RUB", category: "other", ...overrides });
  const post = async (started: TestApp, cookie: string, body: Entry) => expect((await postJson(started, "/api/operations", body, cookie)).status).toBe(201);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("makes the tab with the names of the columns, and writes a row for each entry: when, who, what, how much, the rest", async () => {
    const { started, ivan } = await desk();
    started.setNow(new Date("2026-10-14T15:45:00Z"));
    const body = payment({ comment: "за рейс" });
    await post(started, ivan, body);

    const rows = await google.untilRows("Журнал", 2);
    expect(rows[0]).toEqual(["Дата и время (МСК)", "Кассир", "Операция", "Приход", "Расход", "Валюта", "Курс", "Клиент", "Рейс", "Контрагент", "Сотрудник", "Комментарий", "Статус", "ID записи"]);
    expect(rows[1]).toEqual(["14.10.2026 18:45", "Хожиакбар", "Приход", "86550", "", "₽", "86.55", "A412 Лочинбек", "", "", "", "за рейс", "", body.id]);
  });

  it("writes a correction and a deletion over the entry's own row, with what it says now and its status", async () => {
    const { started, ivan } = await desk();
    const body = expense({ amountMinor: 200_000, comment: "Продукта" });
    await post(started, ivan, body);
    await post(started, ivan, payment());
    await google.untilRows("Журнал", 3);

    expect((await putJson(started, `/api/operations/${body.id}`, { ...body, id: undefined, amountMinor: 250_000 }, ivan)).status).toBe(200);
    await settle();
    expect(google.tab("Журнал")![1]!.slice(2, 5)).toEqual(["Прочее", "", "2500"]);
    expect(google.tab("Журнал")![1]![12]).toBe("изменена");

    expect((await deleteRequest(started, `/api/operations/${body.id}`, ivan)).status).toBe(200);
    await settle();
    expect(google.tab("Журнал")![1]![12]).toBe("удалена");
    expect(google.tab("Журнал")).toHaveLength(3);
    expect(google.appends).toBe(2);
  });

  it("gives an expense without a rate the average of its day, and writes it again when an income of the day changes it", async () => {
    const { started, ivan } = await desk();
    started.setNow(new Date("2026-10-14T15:00:00Z"));
    await post(started, ivan, payment({ rateE4: 860_000 }));
    const spent = expense();
    await post(started, ivan, spent);
    await google.untilRows("Журнал", 3);
    expect(google.tab("Журнал")![2]![6]).toBe("86");

    await post(started, ivan, payment({ rateE4: 870_000 }));
    await google.untilRows("Журнал", 4);
    await settle();
    expect(google.tab("Журнал")![2]![6]).toBe("86.5");
  });

  it("copies only the entries from the day set, and the ones made before it was set up, in the order they were made", async () => {
    const { started, ivan } = await desk("2026-10-14");
    // Google does not take anything for a while: the entries wait.
    google.failNext(503, 1000);
    started.setNow(new Date("2026-10-13T10:00:00Z"));
    await post(started, ivan, payment({ clientCode: "A1 старая" }));
    started.setNow(new Date("2026-10-14T10:00:00Z"));
    const first = payment({ clientCode: "A2" });
    await post(started, ivan, first);
    started.setNow(new Date("2026-10-14T11:00:00Z"));
    const second = expense();
    await post(started, ivan, second);
    // As if the copy had been set up only now: nothing waits, and the worker starts again.
    await started.execute("DELETE FROM sheet_outbox");
    google.clearFailures();
    await started.restart();

    const rows = await google.untilRows("Журнал", 3);
    await settle();
    expect(rows.slice(1).map((row) => row[13])).toEqual([first.id, second.id]);
  });

  it("does not add a row twice when Google refuses a try: the row goes once, when Google takes it", async () => {
    const { started, ivan } = await desk();
    google.failNext(500, 3);
    await post(started, ivan, payment());
    const rows = await google.untilRows("Журнал", 2);
    await settle();
    expect(rows).toHaveLength(2);
    expect(google.appends).toBe(1);
  });
});
