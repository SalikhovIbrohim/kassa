import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { keyOf, KEYS, startFakeOneC, type FakeOneC } from "./helpers/fake-onec.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Json = Record<string, unknown>;
type Queued = { status: string; doc_number: string | null; detail: string | null };

/** A trip that has arrived goes to 1C as the services rendered to its clients: one document to a trip, on the department of the trip. */
describe("writing the trips that have arrived to 1C", () => {
  let app: TestApp | undefined;
  let onec: FakeOneC;

  beforeEach(async () => {
    onec = await startFakeOneC();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await onec.close();
  });

  async function business(options: { mode?: "preview" | "live"; trips?: boolean; from?: string; createClients?: boolean } = {}) {
    const started = await startTestApp({
      kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"),
      clientCodes: "digits",
      warehouses: parseWarehouses("andijan,kokand,tashkent"),
      onec: {
        url: onec.url,
        user: onec.user,
        password: onec.password,
        organizationKey: KEYS.organization,
        kassaKey: KEYS.kassa,
        currencyKey: KEYS.currency,
        mode: options.mode ?? "live",
        documents: options.trips === false ? ["expenses"] : ["trips"],
        from: options.from,
        createClients: options.createClients,
      },
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
    });
    app = started;
    started.setNow(new Date("2026-08-01T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    expect((await postJson(started, "/api/admin/clients/import", { clients: [{ code: "757", name: "Нурбек", priceMilli: 1400 }, { code: "358", name: "Абдулбоис", priceMilli: 1550 }] }, mudir)).status).toBe(200);
    return { started, mudir };
  }

  const line = (clientCode: string, weightG: number, more: Json = {}): Json => ({ id: randomUUID(), warehouse: "andijan", clientCode, weightG, ...more });
  /** A trip with a waybill of two clients, on the road. */
  async function loaded(started: TestApp, mudir: string, number: number) {
    expect((await postJson(started, "/api/trips", { number, driverName: "Уктамжон", driverPhone: "998505058737", truckPlates: "01 019 JLA" }, mudir)).status).toBe(201);
    const first = line("757", 1_169_450, { bags: 45, pieces: 1973, brand: "сахха", sender: "Абдурашид", receiver: "Акмал 45", item: "Халат женская", size: "48-60" });
    const second = line("358", 360_650, { bags: 15 });
    for (const body of [first, second]) expect((await postJson(started, `/api/trips/${number}/cargo`, body, mudir)).status).toBe(201);
    expect((await postJson(started, `/api/trips/${number}/status`, { status: "in_transit" }, mudir)).status).toBe(200);
    return { first, second };
  }
  const arrive = async (started: TestApp, mudir: string, number: number, arrivalDay = "2026-08-16") =>
    expect((await postJson(started, `/api/trips/${number}/status`, { status: "arrived", arrivalDay }, mudir)).status).toBe(200);
  const queued = (started: TestApp) => started.query<Queued>("SELECT status, doc_number, detail FROM onec_outbox ORDER BY id");
  async function until(started: TestApp, status: string) {
    let rows: Queued[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      rows = await queued(started);
      if (rows.some((row) => row.status === status)) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The queue never held "${status}": ${JSON.stringify(rows)}`);
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("writes nothing while the truck is on the road, and one posted document when it has arrived", async () => {
    const nurbek = onec.addClient("757", "Нурбек");
    const abdulbois = onec.addClient("358", "Абдулбоис");
    const { started, mudir } = await business();
    await loaded(started, mudir, 240);
    await settle();
    expect(await queued(started)).toEqual([]);

    await arrive(started, mudir, 240);
    const [row] = await until(started, "written");

    expect(onec.services).toHaveLength(1);
    const document = onec.services[0]!;
    expect(document).toMatchObject({
      Date: "2026-08-16T12:00:00",
      Организация_Key: KEYS.organization,
      ПодразделениеОрганизации_Key: "dep-240",
      Номенклатура_Key: keyOf("Catalog_Номенклатура", "Рейс"),
      ВалютаДокумента_Key: KEYS.currency,
      СчетДоходов_Key: "acc-9030.1",
      СчетРасходов_Key: "acc-9130.1",
      Субконто: keyOf("Catalog_НоменклатурныеГруппы", "Основная группа"),
      // 1169.45 kg at 1.40 and 360.65 kg at 1.55
      СуммаДокумента: 2196.24,
      Экс_НомерМашины: "01 019 JLA",
      Экс_Водитель: "Уктамжон",
      Экс_ТелефонВодителя: "998505058737",
      Posted: true,
    });
    expect(document["Контрагенты"]).toEqual([
      expect.objectContaining({
        LineNumber: "1",
        Контрагент_Key: nurbek.counterpart,
        ДоговорКонтрагента_Key: nurbek.contract,
        Количество: 1169.45,
        Цена: 1.4,
        Сумма: 1637.23,
        СчетУчетаРасчетовСКонтрагентом_Key: "acc-4010",
        СчетУчетаРасчетовПоАвансам_Key: "acc-6310",
        Экс_Мест: "45",
        Экс_Бренд: "сахха",
        Экс_Отправитель: "Абдурашид",
        Экс_Получатель: "Акмал 45",
        Экс_Наименование: "Халат женская, 48-60",
        Экс_Штук: "1973",
      }),
      expect.objectContaining({ LineNumber: "2", Контрагент_Key: abdulbois.counterpart, Количество: 360.65, Цена: 1.55, Сумма: 559.01, Экс_Мест: "15", Экс_Штук: "" }),
    ]);
    expect(row!.detail).toContain(`«Оказание услуг» №${String(document.Number)}`);
    // The admin sees on the trip what became of it.
    const seen = (await (await get(started, "/api/trips/240", mudir)).json()) as { onec?: Json };
    expect(seen.onec).toMatchObject({ status: "written", docNumber: document.Number });
  });

  it("makes the department of the trip and the clients the base does not have, where the settings say so", async () => {
    const { started, mudir } = await business({ createClients: true });
    await loaded(started, mudir, 251);
    await arrive(started, mudir, 251);
    await until(started, "written");

    const department = onec.departments.find((item) => item.Description === "251")!;
    expect(onec.services[0]).toMatchObject({ ПодразделениеОрганизации_Key: department.Ref_Key });
    expect(onec.counterparts.map((item) => item.Description).sort()).toEqual(["Абдулбоис 358", "Нурбек 757"]);
  });

  it("waits for a person when a client of the waybill is not in the base and none is to be made", async () => {
    onec.addClient("757", "Нурбек");
    const { started, mudir } = await business();
    await loaded(started, mudir, 240);
    await arrive(started, mudir, 240);

    const [row] = await until(started, "blocked");
    expect(row!.detail).toContain("358");
    expect(onec.services).toHaveLength(0);

    onec.addClient("358", "Абдулбоис");
    await until(started, "written");
    expect(onec.services).toHaveLength(1);
  });

  it("corrects the document when the waybill is corrected after the arrival, and never makes a second one", async () => {
    onec.addClient("757", "Нурбек");
    onec.addClient("358", "Абдулбоис");
    const { started, mudir } = await business();
    const { second } = await loaded(started, mudir, 240);
    await arrive(started, mudir, 240);
    await until(started, "written");

    expect((await putJson(started, `/api/trips/240/cargo/${String(second.id)}`, { warehouse: "andijan", clientCode: "358", weightG: 400_000, bags: 15 }, mudir)).status).toBe(200);
    for (let attempt = 0; attempt < 200 && onec.services[0]!["СуммаДокумента"] !== 2257.23; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    await until(started, "written");

    expect(onec.services).toHaveLength(1);
    expect(onec.services[0]).toMatchObject({ СуммаДокумента: 2257.23, Posted: true });
    expect((onec.services[0]!["Контрагенты"] as Json[])[1]).toMatchObject({ Количество: 400, Сумма: 620 });
  });

  it("takes over the document that is on the department of the trip already, and unposts and marks it when the trip is sent back on the road", async () => {
    onec.addClient("757", "Нурбек");
    onec.addClient("358", "Абдулбоис");
    const theirs = { Ref_Key: randomUUID(), Number: "0000-000140", Date: "2026-08-16T12:00:00", Posted: false, DeletionMark: false, ПодразделениеОрганизации_Key: "dep-240", Контрагенты: [] };
    onec.services.push(theirs);
    const { started, mudir } = await business();
    await loaded(started, mudir, 240);
    await arrive(started, mudir, 240);
    const [row] = await until(started, "written");

    expect(onec.services).toHaveLength(1);
    expect(row).toMatchObject({ doc_number: "0000-000140" });
    expect(onec.services[0]).toMatchObject({ СуммаДокумента: 2196.24, Posted: true });

    expect((await postJson(started, "/api/trips/240/status", { status: "in_transit" }, mudir)).status).toBe(200);
    await until(started, "removed");
    expect(onec.services[0]).toMatchObject({ Posted: false, DeletionMark: true });
  });

  it("only says what would be written in the rehearsal", async () => {
    onec.addClient("757", "Нурбек");
    const { started, mudir } = await business({ mode: "preview", createClients: true });
    await loaded(started, mudir, 251);
    await arrive(started, mudir, 251);

    const [row] = await until(started, "preview");
    expect(row!.detail).toContain("по рейсу 251: строк 2, клиентов 2");
    expect(row!.detail).toContain("были бы созданы");
    expect(row!.detail).toContain("подразделение «251»");
    expect(onec.requests.filter((item) => !item.startsWith("GET"))).toEqual([]);
  });

  it("writes no trip where the settings do not name them, nor one that arrived before the first day", async () => {
    const off = await business({ trips: false });
    await loaded(off.started, off.mudir, 240);
    await arrive(off.started, off.mudir, 240);
    await settle();
    expect(await queued(off.started)).toEqual([]);
    await off.started.close();

    const early = await business({ from: "2026-09-01" });
    await loaded(early.started, early.mudir, 240);
    await arrive(early.started, early.mudir, 240);
    await settle();
    expect(await queued(early.started)).toEqual([]);
    expect(onec.services).toHaveLength(0);
  });
});
