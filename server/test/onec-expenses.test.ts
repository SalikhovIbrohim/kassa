import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteRequest, loginAs, postJson, putJson } from "./helpers/http.js";
import { keyOf, KEYS, startFakeOneC, type FakeOneC } from "./helpers/fake-onec.js";
import { startFakeTelegram, type FakeTelegram } from "./helpers/fake-telegram.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Entry = Record<string, unknown>;
type Queued = { status: string; doc_number: string | null; detail: string | null };

/** Where the settings say so, the expenses of the cash desk go to 1C as expense orders, filed the way the accountant of the base files them. */
describe("writing the expenses of the cash desk to 1C", () => {
  let app: TestApp | undefined;
  let onec: FakeOneC;
  let telegram: FakeTelegram;

  beforeEach(async () => {
    onec = await startFakeOneC();
    telegram = await startFakeTelegram();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await onec.close();
    await telegram.close();
  });

  async function desk(options: { mode?: "preview" | "live"; documents?: Array<"incomes" | "expenses">; from?: string } = {}) {
    const started = await startTestApp({
      telegramBotToken: "123456:SECRET-TOKEN",
      telegramGroupChatId: "-1001234567890",
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
      onec: {
        url: onec.url,
        user: onec.user,
        password: onec.password,
        organizationKey: KEYS.organization,
        kassaKey: KEYS.kassa,
        currencyKey: KEYS.currency,
        mode: options.mode ?? "live",
        documents: options.documents ?? ["incomes", "expenses"],
        from: options.from,
      },
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
    });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Мухаммад Али" });
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    /** Makes a category and answers with its code. */
    const category = async (body: Entry) => {
      const made = await postJson(started, "/api/admin/categories", body, mudir);
      expect(made.status).toBe(201);
      return ((await made.json()) as { category: { code: string } }).category.code;
    };
    return { started, ivan: await loginAs(started, "ivan", "correct horse"), mudir, category };
  }

  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 18_000, currency: "USD", category: "other", ...overrides });
  const post = async (started: TestApp, cookie: string, body: Entry) => (await postJson(started, "/api/operations", body, cookie)).status;
  const queued = (started: TestApp) => started.query<Queued>("SELECT status, doc_number, detail FROM onec_outbox ORDER BY id");
  async function until(started: TestApp, status: string, count = 1) {
    let rows: Queued[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      rows = await queued(started);
      if (rows.filter((row) => row.status === status).length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The queue never held ${count} of "${status}": ${JSON.stringify(rows)}`);
  }

  it("writes an expense of a trip as a cost of that trip: production, the item of the category, the department of the trip", async () => {
    const { started, ivan, category } = await desk();
    const pusher = await category({ kind: "expense", label: "Толкач", requiresTrip: true });

    expect(await post(started, ivan, expense({ category: pusher, tripNumber: 240, recipient: "Сардор", comment: "до границы" }))).toBe(201);
    const [row] = await until(started, "written");

    expect(onec.documents).toHaveLength(0);
    expect(onec.expenses).toHaveLength(1);
    expect(onec.expenses[0]).toMatchObject({
      ВидОперации: "ПрочийРасход",
      Организация_Key: KEYS.organization,
      КассаОрганизации_Key: KEYS.kassa,
      ВалютаДокумента_Key: KEYS.currency,
      СуммаДокумента: 180,
      СчетКасса_Key: "acc-5010",
      СчетУчетаРасчетовСКонтрагентом_Key: "acc-2010",
      СубконтоДт1: keyOf("Catalog_НоменклатурныеГруппы", "Основная группа"),
      СубконтоДт2: keyOf("Catalog_СтатьиЗатрат", "Толкач"),
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Толкач"),
      ПодразделениеОрганизации_Key: "dep-240",
      ПодразделениеДт_Key: "dep-240",
      Выдать: "Сардор",
      Комментарий: "Толкач рейс 240 до границы",
      Posted: true,
    });
    expect(row!.detail).toContain(`РКО №${String(onec.expenses[0]!.Number)}`);
  });

  it("makes the department of a trip the base does not have yet, like the departments of the other trips", async () => {
    const { started, ivan, category } = await desk();
    const pusher = await category({ kind: "expense", label: "Толкач", requiresTrip: true });

    await post(started, ivan, expense({ category: pusher, tripNumber: 251 }));
    await until(started, "written");

    const made = onec.departments.find((row) => row.Description === "251");
    expect(made).toMatchObject({ Owner_Key: KEYS.organization });
    expect(onec.expenses[0]).toMatchObject({ ПодразделениеОрганизации_Key: made!.Ref_Key });
    // The next cost of the trip finds it: one department to a trip.
    await post(started, ivan, expense({ category: pusher, tripNumber: 251, amountMinor: 500 }));
    await until(started, "written", 2);
    expect(onec.departments.filter((row) => row.Description === "251")).toHaveLength(1);
  });

  it("files a trip expense of a category the base has no item for under the other costs of the trip, with the cash flow of the city", async () => {
    const { started, ivan, category } = await desk();
    const papers = await category({ kind: "expense", label: "Пломба", requiresTrip: true });

    await post(started, ivan, expense({ category: papers, tripNumber: 240 }));
    await until(started, "written");

    expect(onec.expenses[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом_Key: "acc-2010",
      СубконтоДт2: keyOf("Catalog_СтатьиЗатрат", "Прочие расходы"),
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Прочие расходы Москва"),
      ПодразделениеОрганизации_Key: "dep-240",
    });
  });

  it("writes an expense of no trip as an other expense of the city of its desk, and a category the base keeps by name under that name", async () => {
    const { started, ivan, category } = await desk();
    const lunch = await category({ kind: "expense", label: "Обед" });

    await post(started, ivan, expense({ comment: "вода кулер" }));
    await post(started, ivan, expense({ category: lunch, amountMinor: 1_500 }));
    await until(started, "written", 2);

    const none = "00000000-0000-0000-0000-000000000000";
    expect(onec.expenses[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом_Key: "acc-9430",
      СубконтоДт1: keyOf("Catalog_ПрочиеДоходыИРасходы", "Прочие внереализационные доходы (расходы)"),
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Прочие расходы Москва"),
      ПодразделениеОрганизации_Key: none,
      Комментарий: "Прочее вода кулер",
    });
    expect(onec.expenses[1]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом_Key: "acc-9430",
      СубконтоДт1: keyOf("Catalog_ПрочиеДоходыИРасходы", "Обед"),
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "обед"),
      СуммаДокумента: 15,
    });
  });

  it("corrects the order when the expense is corrected, and unposts and marks it when the expense is deleted", async () => {
    const { started, ivan, mudir } = await desk();
    const body = expense();
    await post(started, ivan, body);
    await until(started, "written");

    expect((await putJson(started, `/api/operations/${String(body.id)}`, { type: "expense", amountMinor: 20_000, currency: "USD", category: "other", reason: "ошибка в сумме" }, mudir)).status).toBe(200);
    for (let attempt = 0; attempt < 200 && onec.expenses[0]!["СуммаДокумента"] !== 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    await until(started, "written");
    expect(onec.expenses).toHaveLength(1);
    expect(onec.expenses[0]).toMatchObject({ СуммаДокумента: 200, Posted: true });

    expect((await deleteRequest(started, `/api/operations/${String(body.id)}`, mudir, { reason: "двойная запись" })).status).toBe(200);
    await until(started, "removed");
    expect(onec.expenses[0]).toMatchObject({ Posted: false, DeletionMark: true });
  });

  it("leaves money handed to the owner and money given back to a client to a person", async () => {
    const { started, ivan, category } = await desk();
    const salary = await category({ kind: "expense", label: "Выплата заработной платы", requiresEmployee: true });
    const moved = await category({ kind: "expense", label: "Внутреннее перемещение денежных средств" });
    await post(started, ivan, expense({ category: salary, employee: "Ислом" }));
    await post(started, ivan, expense({ category: moved }));
    expect((await until(started, "skipped", 2)).map((row) => row.detail)).toEqual([
      "выплата сотруднику записывается в 1С вручную",
      "перемещение без кассы-получателя записывается в 1С вручную",
    ]);
    await started.query("DELETE FROM onec_outbox");

    await post(started, ivan, expense({ category: "client_refund", clientCode: "А406" }));
    const rows = await until(started, "skipped");

    expect(rows.map((row) => row.detail)).toEqual(["возврат клиенту записывается в 1С вручную"]);
    expect(onec.expenses).toHaveLength(0);
  });

  it("writes money handed to the owner as dividends to the founder the base paid last", async () => {
    onec.expenses.push({ Ref_Key: randomUUID(), Number: "0000-С00905", Date: "2026-10-24T12:00:02", Posted: true, DeletionMark: false, ВидОперации: "ВыплатаДивидендовИлиПроцентов", Контрагент: "founder-key" });
    const { started, ivan } = await desk();

    await post(started, ivan, expense({ category: "owner_handover", amountMinor: 100_000, comment: "ремонт" }));
    await until(started, "written");

    expect(onec.expenses[1]).toMatchObject({
      ВидОперации: "ВыплатаДивидендовИлиПроцентов",
      Контрагент: "founder-key",
      СуммаДокумента: 1000,
      СуммаВыплаты: 1000,
      СчетРасчетовКонтрагентов_Key: "acc-6610",
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Выплата дивидендов"),
      ТипВыплатыДивидендовИлиПроцентов: "Дивиденды",
      Выдать: "Учредитель",
      Posted: true,
    });
  });

  it("writes a payment to a supplier to the counterpart of that very name and their contract, and waits when the base has none", async () => {
    const supplier = randomUUID();
    onec.counterparts.push({ Ref_Key: supplier, Description: "Андрей Аренда", ИНН: "", DeletionMark: false, IsFolder: false });
    onec.contracts.push({ Ref_Key: "contract-rent", Description: "Аренда склада", Owner_Key: supplier, ВидДоговора: "СПоставщиком", DeletionMark: false });
    const { started, ivan, category } = await desk();
    const paid = await category({ kind: "expense", label: "Оплата поставщикам (подрядчикам)", requiresCounterparty: true });

    await post(started, ivan, expense({ category: paid, counterparty: "андрей  аренда", amountMinor: 1_162_700 }));
    await until(started, "written");
    expect(onec.expenses[0]).toMatchObject({
      ВидОперации: "ОплатаПоставщику",
      Контрагент: supplier,
      ДоговорКонтрагента_Key: "contract-rent",
      СуммаДокумента: 11627,
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Оплата поставщикам (подрядчикам)"),
      Выдать: "Андрей Аренда",
      Posted: true,
    });
    expect(onec.expenses[0]!["РасшифровкаПлатежа"]).toEqual([
      expect.objectContaining({ ДоговорКонтрагента_Key: "contract-rent", СуммаПлатежа: 11627, СчетУчетаРасчетовСКонтрагентом_Key: "acc-6010", СчетУчетаРасчетовПоАвансам_Key: "acc-4310" }),
    ]);

    await post(started, ivan, expense({ category: paid, counterparty: "Неизвестный" }));
    const rows = await until(started, "blocked");
    expect(rows[1]!.detail).toContain("нет контрагента с названием «Неизвестный»");
    expect(onec.expenses).toHaveLength(1);
  });

  it("only says what would be written in the rehearsal, and writes nothing", async () => {
    const { started, ivan, category } = await desk({ mode: "preview" });
    const pusher = await category({ kind: "expense", label: "Толкач", requiresTrip: true });

    await post(started, ivan, expense({ category: pusher, tripNumber: 251 }));
    await post(started, ivan, expense());
    const rows = await until(started, "preview", 2);

    expect(rows[0]!.detail).toContain("было бы создано подразделение «251»");
    expect(rows[0]!.detail).toContain("статья затрат «Толкач»");
    expect(rows[1]!.detail).toContain("был бы записан РКО на");
    expect(rows[1]!.detail).toContain("«Прочие расходы Москва»");
    expect(onec.requests.filter((line) => !line.startsWith("GET"))).toEqual([]);
  });

  it("writes no expense where the settings do not name them", async () => {
    const { started, ivan } = await desk({ documents: ["incomes"] });

    await post(started, ivan, expense());
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await queued(started)).toEqual([]);
  });

  it("writes an income of any category that names a client as a payment of that client, where the settings say so", async () => {
    const { counterpart } = onec.addClient("А406", "Жавид");
    const { started, ivan, category } = await desk();
    const elsewhere = await category({ kind: "income", label: "Клиент дал деньги в Ташкенте", requiresClient: true });

    await post(started, ivan, { id: randomUUID(), type: "income", amountMinor: 70_000, currency: "USD", category: elsewhere, clientCode: "А406" });
    await until(started, "written");

    expect(onec.documents[0]).toMatchObject({ ВидОперации: "ОплатаПокупателя", Контрагент: counterpart, СуммаДокумента: 700 });
  });

  it("leaves alone what is of before the first day that goes to 1C", async () => {
    const { started, ivan } = await desk({ from: "2999-01-01" });

    await post(started, ivan, expense());
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await queued(started)).toEqual([]);
    expect(onec.expenses).toHaveLength(0);
  });
});
