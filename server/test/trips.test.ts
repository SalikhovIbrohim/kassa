import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { importHistory, type HistoryFile } from "../src/admin/history.js";
import { AdminError } from "../src/admin/users.js";
import { loadConfig } from "../src/config.js";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import pg from "pg";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

type Json = Record<string, unknown>;
type Detail = {
  trip: { number: number; status: string; loadingDay: string | null; departureDay: string | null; arrivalDay: string | null; direction: string | null; lines: number; bags: number; weightG: number; amountMinor: number; driverName: string | null };
  cargo: Array<Json & { id: string; amountMinor: number; mine: boolean; warehouse: string; truckPart: string | null; place: number | null; clientCode: string; priceMilli: number }>;
  clients: Array<{ code: string; name: string; bags: number; weightG: number; amountMinor: number; debtMinor: number }>;
  places: { head: number; trailer: number };
  may: { edit: boolean; warehouses: string[]; forward: string | null; back: string | null; admin: boolean; remove: boolean };
  money?: { expenseMinor: number; profitMinor: number };
};

describe("the warehouses named in the settings (WAREHOUSES)", () => {
  it("are none when the settings say nothing: the business keeps no trips", () => {
    for (const setting of [undefined, "", "   "]) {
      const none = parseWarehouses(setting);
      expect(none.list).toEqual([]);
      expect(none.enabled).toBe(false);
    }
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" }).warehouses.enabled).toBe(false);
  });

  it("are read from the setting, in the order a truck passes them: a city the code knows by itself, any other with its name", () => {
    const three = parseWarehouses(" andijan, kokand ,tashkent ");
    expect(three.list).toEqual([
      { id: "andijan", label: "Андижан" },
      { id: "kokand", label: "Коканд" },
      { id: "tashkent", label: "Ташкент" },
    ]);
    expect(three.enabled).toBe(true);
    expect(parseWarehouses("fergana=Фергана,andijan=Склад в Андижане").list).toEqual([
      { id: "fergana", label: "Фергана" },
      { id: "andijan", label: "Склад в Андижане" },
    ]);
    expect(loadConfig({ DATABASE_URL: "postgres://x/y", WAREHOUSES: "andijan,kokand" }).warehouses.ids).toEqual(["andijan", "kokand"]);
    // A keeper writes the cargo of their own warehouse, a person of everywhere of any; nobody of one that is not there.
    expect(three.mayUse("kokand", "kokand")).toBe(true);
    expect(three.mayUse("kokand", "andijan")).toBe(false);
    expect(three.mayUse(null, "tashkent")).toBe(true);
    expect(three.mayUse(null, "moscow")).toBe(false);
    expect(three.labelOf("namangan")).toBe("namangan");
  });

  it("refuses a setting that cannot be right, and says what is wrong with it", () => {
    const bad: Array<[string, RegExp]> = [
      [",", /names no warehouse/],
      ["Andijan", /not an id/],
      ["andijan,andijan", /twice/],
      ["namangan", /no name for/],
      ["fergana=", /not an id|empty/],
      [`fergana=${"я".repeat(31)}`, /longer than 30/],
      ["fergana=��", /UTF-8/],
    ];
    for (const [setting, message] of bad) expect(() => parseWarehouses(setting), setting).toThrow(message);
  });
});

/** Groupage: the trips, the cargo on them, and what the clients owe for it, in the one book of the cash desk. */
describe("the trips", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A business like the one this was made for: three desks of dollars, codes of digits, three warehouses. */
  async function business(options: Parameters<typeof startTestApp>[0] = {}) {
    const started = await startTestApp({
      kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"),
      clientCodes: "digits",
      warehouses: parseWarehouses("andijan,kokand,tashkent"),
      ...options,
    });
    app = started;
    // A day of the summer the trucks of these tests leave and arrive in.
    started.setNow(new Date("2026-08-01T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "sklad", password: "warehouse pass", role: "warehouse", displayName: "Завсклад" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const person = async (login: string, displayName: string, role: string, city: string | null) => {
      const made = await postJson(started, "/api/admin/users", { login, displayName, password: "some long pass", role, city }, mudir);
      expect(made.status, login).toBe(201);
      return loginAs(started, login, "some long pass");
    };
    return {
      started,
      mudir,
      owner: await loginAs(started, "owner", "long enough pass"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      // A keeper of every warehouse, and one of Andijan and one of Kokand.
      sklad: await loginAs(started, "sklad", "warehouse pass"),
      andijan: await person("anvar", "Анвар", "warehouse", "andijan"),
      kokand: await person("qodir", "Қодир", "warehouse", "kokand"),
    };
  }

  const clients = (started: TestApp, cookie: string, list: Json[]) => postJson(started, "/api/admin/clients/import", { clients: list }, cookie);
  const trip = async (started: TestApp, cookie: string, number: number, more: Json = {}) => {
    const made = await postJson(started, "/api/trips", { number, ...more }, cookie);
    expect(made.status, `trip ${number}`).toBe(201);
    return (await made.json()) as Detail;
  };
  const line = (clientCode: string, weightG: number, more: Json = {}): Json => ({ id: randomUUID(), warehouse: "andijan", clientCode, weightG, ...more });
  /** What a correction of a line says: the same as a new line, without an id of its own. */
  const fields = (clientCode: string, weightG: number, more: Json = {}): Json => ({ warehouse: "andijan", clientCode, weightG, ...more });
  const add = (started: TestApp, cookie: string, number: number, body: Json) => postJson(started, `/api/trips/${number}/cargo`, body, cookie);
  const added = async (started: TestApp, cookie: string, number: number, body: Json) => {
    const answer = await add(started, cookie, number, body);
    expect(answer.status, JSON.stringify(body)).toBe(201);
    return (await answer.json()) as Detail;
  };
  const status = (started: TestApp, cookie: string, number: number, body: Json) => postJson(started, `/api/trips/${number}/status`, body, cookie);
  const detail = async (started: TestApp, cookie: string, number: number) => (await (await get(started, `/api/trips/${number}`, cookie)).json()) as Detail;
  const arrive = async (started: TestApp, cookie: string, number: number, arrivalDay = "2026-08-16") => {
    expect((await status(started, cookie, number, { status: "in_transit" })).status).toBe(200);
    expect((await status(started, cookie, number, { status: "arrived", arrivalDay })).status).toBe(200);
  };
  const debtOf = async (started: TestApp, cookie: string, code: string) => {
    const found = (await (await get(started, `/api/clients?q=${encodeURIComponent(code)}`, cookie)).json()).clients as Array<Json & { code: string }>;
    const client = found.find((item) => item.code === code)!;
    return { opening: client.openingDebtMinor, charged: client.chargedMinor, paid: client.paidMinor, debt: client.debtMinor };
  };
  const payment = (clientCode: string, amountMinor: number, more: Json = {}): Json => ({ id: randomUUID(), type: "income", amountMinor, currency: "USD", category: "client_payment", clientCode, ...more });

  it("are not there at all where the settings name no warehouse, and nothing else of the cash desk changes", async () => {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin" });
    const mudir = await loginAs(started, "mudir", "admin password");
    expect(await (await get(started, "/api/warehouses", mudir)).json()).toEqual({ warehouses: [] });
    for (const answer of [await get(started, "/api/trips", mudir), await postJson(started, "/api/trips", { number: 1 }, mudir), await get(started, "/api/trips/1", mudir)]) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "trips_disabled" });
    }
    // A client is what it always was: no price, no debt, and neither is taken.
    expect(await (await postJson(started, "/api/admin/clients", { code: "А707", name: "Карим" }, mudir)).json()).toEqual({
      client: { code: "А707", name: "Карим", phone: null, note: null, active: true },
    });
    expect((await postJson(started, "/api/admin/clients", { code: "А708", priceMilli: 1500 }, mudir)).status).toBe(400);
    expect((await patchJson(started, `/api/admin/clients/${encodeURIComponent("А707")}`, { openingDebtMinor: 100 }, mudir)).status).toBe(400);
    // Nobody keeps a warehouse where there is none.
    const keeper = await postJson(started, "/api/admin/users", { login: "sklad", password: "some long pass", role: "warehouse" }, mudir);
    expect(keeper.status).toBe(400);
    expect(await keeper.json()).toEqual({ error: "bad_role" });
  });

  it("are made by the admin and by the keepers of the warehouses, one to a number, and listed newest first", async () => {
    const { started, mudir, owner, ivan, sklad } = await business();
    expect(await (await get(started, "/api/warehouses", sklad)).json()).toEqual({
      warehouses: [
        { id: "andijan", label: "Андижан" },
        { id: "kokand", label: "Коканд" },
        { id: "tashkent", label: "Ташкент" },
      ],
    });
    expect(await (await get(started, "/api/trips", mudir)).json()).toEqual({ trips: [], nextBefore: null, nextNumber: 1, mayCreate: true });

    const first = await trip(started, mudir, 190, { driverName: " Жахонгир ", departureDay: "2026-07-31" });
    expect(first.trip).toEqual({
      number: 190, driverName: "Жахонгир", driverPhone: null, truckPlates: null, note: null, direction: null,
      loadingDay: null, departureDay: "2026-07-31", arrivalDay: null, status: "loading", fromCardFile: false, lines: 0, bags: 0, weightG: 0, amountMinor: 0,
    });
    await trip(started, sklad, 191, { truckPlates: "01 019 OKA / 01 55 39 BA" });
    const again = await postJson(started, "/api/trips", { number: 190 }, sklad);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "trip_exists" });

    const list = (await (await get(started, "/api/trips", owner)).json()) as { trips: Array<{ number: number }>; nextNumber: number; mayCreate: boolean; nextBefore: number | null };
    expect(list.trips.map((item) => item.number)).toEqual([191, 190]);
    expect(list.nextNumber).toBe(192);
    expect(list.mayCreate).toBe(false);
    const page = (await (await get(started, "/api/trips?limit=1", owner)).json()) as typeof list;
    expect(page.trips.map((item) => item.number)).toEqual([191]);
    expect(page.nextBefore).toBe(191);
    expect(((await (await get(started, "/api/trips?limit=1&before=191", owner)).json()) as typeof list).trips.map((item) => item.number)).toEqual([190]);

    // The owner looks and makes nothing; a cashier does not come here at all.
    expect((await postJson(started, "/api/trips", { number: 200 }, owner)).status).toBe(403);
    expect((await get(started, "/api/trips", ivan)).status).toBe(403);
    expect((await get(started, "/api/trips/190", ivan)).status).toBe(403);
    expect((await get(started, "/api/trips", undefined)).status).toBe(401);
    // What is not a trip that could be.
    expect((await postJson(started, "/api/trips", { number: 0 }, mudir)).status).toBe(400);
    expect((await postJson(started, "/api/trips", { number: 192, departureDay: "2026-02-30" }, mudir)).status).toBe(400);
    expect((await get(started, "/api/trips/999", mudir)).status).toBe(404);
  });

  it("take a line of cargo by its weight and the price of a kilogram, the client's own unless the line says another", async () => {
    const { started, mudir, sklad } = await business();
    await clients(started, mudir, [
      { code: "70", name: "Лочин", priceMilli: 1550 },
      { code: "132", name: "Иброхим", priceMilli: 1500 },
      { code: "3", name: "Рахимберди" },
    ]);
    await trip(started, mudir, 190);

    // 1 075 kg at 1,55 $ is 1 666,25 $.
    const one = await added(started, sklad, 190, line("70", 1_075_000, { sender: "М Али", item: "Трико мужская с ночёсом", brand: "али тех", size: "48-58", bags: 30, pieces: 3000 }));
    expect(one.cargo).toHaveLength(1);
    expect(one.cargo[0]).toMatchObject({
      warehouse: "andijan", clientCode: "70", clientName: "Лочин", sender: "М Али", receiverPhone: null, item: "Трико мужская с ночёсом", brand: "али тех", size: "48-58",
      bags: 30, perBag: null, pieces: 3000, weightG: 1_075_000, priceMilli: 1550, amountMinor: 166_625, note: null, author: "Завсклад", mine: true,
    });
    // The code as it is typed in the form, with the name after it; and a price of the line's own.
    const two = await added(started, sklad, 190, line("132 Иброхим", 3_686_500, { priceMilli: 1600, bags: 120, warehouse: "kokand" }));
    expect(two.cargo[1]).toMatchObject({ clientCode: "132", priceMilli: 1600, amountMinor: 589_840, warehouse: "kokand" });
    expect(two.trip).toMatchObject({ lines: 2, bags: 150, weightG: 4_761_500, amountMinor: 166_625 + 589_840 });

    // A client without a price of their own: the line has to say one.
    const priceless = await add(started, sklad, 190, line("3", 204_820));
    expect(priceless.status).toBe(400);
    expect(await priceless.json()).toEqual({ error: "price_required" });
    expect((await add(started, sklad, 190, line("3", 204_820, { priceMilli: 1500 }))).status).toBe(201);

    // Nobody the directory does not have, no warehouse the business does not have, no weight of nothing.
    const stranger = await add(started, sklad, 190, line("999", 1000, { priceMilli: 1500 }));
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toEqual({ error: "unknown_client" });
    const nowhere = await add(started, sklad, 190, line("70", 1000, { warehouse: "moscow" }));
    expect(nowhere.status).toBe(400);
    expect(await nowhere.json()).toEqual({ error: "bad_warehouse" });
    expect((await add(started, sklad, 190, line("70", 0))).status).toBe(400);
    expect((await add(started, sklad, 999, line("70", 1000))).status).toBe(404);
    expect((await detail(started, mudir, 190)).cargo).toHaveLength(3);
  });

  it("store a line that is sent twice once", async () => {
    const { started, mudir, sklad } = await business();
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, mudir, 190);
    await trip(started, mudir, 191);
    const body = line("70", 100_000);
    expect((await add(started, sklad, 190, body)).status).toBe(201);
    const again = await add(started, sklad, 190, body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Detail).cargo).toHaveLength(1);
    // The same id on another truck is another line: refused.
    const elsewhere = await add(started, sklad, 191, body);
    expect(elsewhere.status).toBe(409);
    expect(await elsewhere.json()).toEqual({ error: "cargo_id_conflict" });
  });

  it("round what a client owes for a trip once, for all the lines of the client together", async () => {
    const { started, mudir, sklad } = await business();
    await clients(started, mudir, [{ code: "658", name: "Косим", priceMilli: 1500 }, { code: "10", name: "Фарух", priceMilli: 1500 }]);
    await trip(started, mudir, 190);
    // 259,85 kg and 530,85 kg at 1,5 $: 389,775 $ and 796,275 $, which read 389,78 and 796,28 and are 1 186,05 together.
    await added(started, sklad, 190, line("658", 259_850));
    await added(started, sklad, 190, line("658", 530_850));
    const loaded = await added(started, sklad, 190, line("10", 489_240));
    expect(loaded.cargo.map((item) => item.amountMinor)).toEqual([38_978, 79_628, 73_386]);
    // By the number of the code, as the card file lists them.
    expect(loaded.clients).toEqual([
      { code: "10", name: "Фарух", bags: 0, weightG: 489_240, amountMinor: 73_386, debtMinor: 0 },
      { code: "658", name: "Косим", bags: 0, weightG: 790_700, amountMinor: 118_605, debtMinor: 0 },
    ]);
    expect(loaded.trip.amountMinor).toBe(191_991);
    await arrive(started, mudir, 190);
    expect((await debtOf(started, mudir, "658")).charged).toBe(118_605);
  });

  it("go from loading to the road to arrived, one step at a time, and only an arrived trip is owed for", async () => {
    const { started, mudir, sklad, owner } = await business();
    started.setNow(new Date("2026-08-01T09:00:00Z"));
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, sklad, 190);
    await added(started, sklad, 190, line("70", 100_000));
    expect((await detail(started, sklad, 190)).may).toEqual({ edit: true, warehouses: ["andijan", "kokand", "tashkent"], forward: "in_transit", back: null, admin: false, remove: false });
    expect((await debtOf(started, mudir, "70")).debt).toBe(0);

    // Not straight to arrived, and the owner moves nothing.
    expect(await (await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-08-16" })).json()).toEqual({ error: "wrong_status" });
    expect((await status(started, owner, 190, { status: "in_transit" })).status).toBe(403);

    // The truck left: today, since nobody said which day.
    const left = (await (await status(started, sklad, 190, { status: "in_transit" })).json()) as Detail;
    expect(left.trip).toMatchObject({ status: "in_transit", departureDay: "2026-08-01", arrivalDay: null });
    expect((await status(started, sklad, 190, { status: "in_transit" })).status).toBe(200);
    expect((await debtOf(started, mudir, "70")).debt).toBe(0);

    // It arrives on a day, which is said, is a day, and is not before it left.
    expect(await (await status(started, sklad, 190, { status: "arrived" })).json()).toEqual({ error: "arrival_day_required" });
    expect((await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-02-30" })).status).toBe(400);
    expect(await (await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-07-30" })).json()).toEqual({ error: "arrival_before_departure" });
    expect((await status(started, sklad, 190, { status: "in_transit", arrivalDay: "2026-08-16" })).status).toBe(400);
    const arrived = (await (await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-08-16" })).json()) as Detail;
    expect(arrived.trip).toMatchObject({ status: "arrived", departureDay: "2026-08-01", arrivalDay: "2026-08-16" });
    expect(arrived.clients).toEqual([{ code: "70", name: "Лочин", bags: 0, weightG: 100_000, amountMinor: 15_000, debtMinor: 15_000 }]);
    expect(await debtOf(started, mudir, "70")).toEqual({ opening: 0, charged: 15_000, paid: 0, debt: 15_000 });
    // Asked again (the answer was lost): as it is.
    expect((await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-08-16" })).status).toBe(200);

    // From now on the waybill is closed to the keepers: the debts stand on it.
    expect(arrived.may).toEqual({ edit: false, warehouses: [], forward: null, back: null, admin: false, remove: false });
    expect(arrived.cargo[0]!.mine).toBe(false);
    const late = await add(started, sklad, 190, line("70", 5_000));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "trip_arrived" });
    expect((await putJson(started, `/api/trips/190/cargo/${arrived.cargo[0]!.id}`, fields("70", 90_000), sklad)).status).toBe(409);
    expect((await deleteRequest(started, `/api/trips/190/cargo/${arrived.cargo[0]!.id}`, sklad)).status).toBe(409);
    expect((await patchJson(started, "/api/trips/190", { driverName: "Другой" }, sklad)).status).toBe(409);
    // Another day of arrival, and a step back, are the admin's.
    expect((await status(started, sklad, 190, { status: "arrived", arrivalDay: "2026-08-17" })).status).toBe(403);
    expect((await status(started, sklad, 190, { status: "in_transit" })).status).toBe(403);

    // The admin puts right what stands: a line more, another day, and a step back takes the debt away again.
    const admin = await detail(started, mudir, 190);
    expect(admin.may).toEqual({ edit: true, warehouses: ["andijan", "kokand", "tashkent"], forward: null, back: "in_transit", admin: true, remove: false });
    await added(started, mudir, 190, line("70", 10_000));
    expect((await debtOf(started, mudir, "70")).debt).toBe(16_500);
    expect(((await (await status(started, mudir, 190, { status: "arrived", arrivalDay: "2026-08-17" })).json()) as Detail).trip.arrivalDay).toBe("2026-08-17");
    expect(((await (await patchJson(started, "/api/trips/190", { arrivalDay: "2026-08-18" }, mudir)).json()) as Detail).trip.arrivalDay).toBe("2026-08-18");
    const back = (await (await status(started, mudir, 190, { status: "in_transit" })).json()) as Detail;
    expect(back.trip).toMatchObject({ status: "in_transit", arrivalDay: null });
    expect((await debtOf(started, mudir, "70")).debt).toBe(0);
    expect((await patchJson(started, "/api/trips/190", { arrivalDay: "2026-08-18" }, mudir)).status).toBe(409);
  });

  it("let the keeper of a warehouse write the cargo of that warehouse only", async () => {
    const { started, mudir, sklad, andijan, kokand } = await business();
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, andijan, 190);
    const own = await added(started, andijan, 190, line("70", 100_000));
    expect(own.may.warehouses).toEqual(["andijan"]);
    const foreign = await add(started, andijan, 190, line("70", 100_000, { warehouse: "kokand" }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "warehouse_forbidden" });

    // The keeper of Kokand sees the line of Andijan and does not touch it; nor moves a line of their own there.
    const seen = await detail(started, kokand, 190);
    expect(seen.cargo[0]!.mine).toBe(false);
    const id = seen.cargo[0]!.id;
    expect((await putJson(started, `/api/trips/190/cargo/${id}`, fields("70", 90_000, { warehouse: "kokand" }), kokand)).status).toBe(403);
    expect((await deleteRequest(started, `/api/trips/190/cargo/${id}`, kokand)).status).toBe(403);
    const theirs = await added(started, kokand, 190, line("70", 50_000, { warehouse: "kokand" }));
    expect((await putJson(started, `/api/trips/190/cargo/${theirs.cargo[1]!.id}`, fields("70", 50_000, { warehouse: "andijan" }), kokand)).status).toBe(403);

    // A keeper of everywhere, and the admin, write the cargo of any warehouse.
    expect((await putJson(started, `/api/trips/190/cargo/${id}`, fields("70", 90_000, { warehouse: "tashkent" }), sklad)).status).toBe(200);
    expect((await deleteRequest(started, `/api/trips/190/cargo/${theirs.cargo[1]!.id}`, mudir)).status).toBe(200);
    expect((await detail(started, mudir, 190)).cargo.map((item) => [item.warehouse, item.weightG])).toEqual([["tashkent", 90_000]]);
  });

  it("correct a line and take it off, keeping what it said", async () => {
    const { started, mudir, sklad, owner } = await business();
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }, { code: "132", name: "Иброхим", priceMilli: 1600 }]);
    await trip(started, sklad, 190);
    const first = await added(started, sklad, 190, line("70", 100_000, { item: "Футболка", bags: 10 }));
    const id = first.cargo[0]!.id;

    // What is not sent is emptied; the price stays the line's own unless another is said.
    const corrected = (await (await putJson(started, `/api/trips/190/cargo/${id}`, { warehouse: "andijan", clientCode: "132", weightG: 120_000, brand: "спарта" }, sklad)).json()) as Detail;
    expect(corrected.cargo[0]).toMatchObject({ clientCode: "132", clientName: "Иброхим", item: null, brand: "спарта", bags: null, weightG: 120_000, priceMilli: 1500, amountMinor: 18_000 });
    // A client that was switched off since stays on the line that has them, and is not put on another.
    await patchJson(started, "/api/admin/clients/132", { active: false }, mudir);
    expect((await putJson(started, `/api/trips/190/cargo/${id}`, { warehouse: "andijan", clientCode: "132", weightG: 130_000 }, sklad)).status).toBe(200);
    expect(await (await add(started, sklad, 190, line("132", 1000))).json()).toEqual({ error: "unknown_client" });

    const off = (await (await deleteRequest(started, `/api/trips/190/cargo/${id}`, sklad)).json()) as Detail;
    expect(off.cargo).toEqual([]);
    expect(off.trip).toMatchObject({ lines: 0, weightG: 0, amountMinor: 0 });
    // Taken off twice is taken off; a line that never was is not found; the row is still in its table.
    expect((await deleteRequest(started, `/api/trips/190/cargo/${id}`, sklad)).status).toBe(200);
    expect((await deleteRequest(started, `/api/trips/190/cargo/${randomUUID()}`, sklad)).status).toBe(404);
    expect((await putJson(started, `/api/trips/190/cargo/${id}`, fields("70", 1000), sklad)).status).toBe(404);
    // A correction is not a new line: it has no id of its own to send.
    expect((await putJson(started, `/api/trips/190/cargo/${id}`, line("70", 1000), sklad)).status).toBe(400);
    expect(await started.query("SELECT count(*)::int AS n FROM trip_cargo")).toEqual([{ n: 1 }]);

    // Everything that was done, in order, for the owner and the admin; a keeper is not told.
    const history = (await (await get(started, "/api/trips/190/history", owner)).json()) as { changes: Array<{ action: string; by: { login: string }; before: Json | null; after: Json | null }> };
    expect(history.changes.map((change) => change.action)).toEqual(["create", "add_cargo", "edit_cargo", "edit_cargo", "delete_cargo"]);
    expect(history.changes[2]).toMatchObject({ by: { login: "sklad" }, before: { clientCode: "70", weightG: 100_000, item: "Футболка" }, after: { clientCode: "132", weightG: 120_000, item: null } });
    expect((await get(started, "/api/trips/190/history", sklad)).status).toBe(403);
    // The history is final, whoever asks the database.
    await expect(started.execute("DELETE FROM trip_changes")).rejects.toThrow(/never changed or deleted/);
    await expect(started.execute("UPDATE trip_changes SET action = 'edit'")).rejects.toThrow(/never changed or deleted/);
  });

  it("keep the header of a trip, and leave its number and its removal to the admin", async () => {
    const { started, mudir, sklad, owner } = await business();
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, sklad, 190);
    const kept = (await (await patchJson(started, "/api/trips/190", { driverName: "Жахонгир", driverPhone: "99890 123 45 67", truckPlates: "50 745 VBA", departureDay: "2026-07-31", note: " через Коканд " }, sklad)).json()) as Detail;
    expect(kept.trip).toMatchObject({ driverName: "Жахонгир", driverPhone: "99890 123 45 67", truckPlates: "50 745 VBA", departureDay: "2026-07-31", note: "через Коканд" });
    expect(((await (await patchJson(started, "/api/trips/190", { driverPhone: "", departureDay: null }, sklad)).json()) as Detail).trip).toMatchObject({ driverName: "Жахонгир", driverPhone: null, departureDay: null });
    expect((await patchJson(started, "/api/trips/190", { driverName: "Кто-то" }, owner)).status).toBe(403);
    expect((await patchJson(started, "/api/trips/190", {}, sklad)).status).toBe(400);

    // The number: the admin's, and never one that another trip has.
    await trip(started, sklad, 191);
    expect((await patchJson(started, "/api/trips/190", { number: 189 }, sklad)).status).toBe(403);
    expect(await (await patchJson(started, "/api/trips/190", { number: 191 }, mudir)).json()).toEqual({ error: "trip_exists" });
    expect(((await (await patchJson(started, "/api/trips/190", { number: 189 }, mudir)).json()) as Detail).trip.number).toBe(189);
    expect((await get(started, "/api/trips/190", mudir)).status).toBe(404);

    // A trip made by mistake goes while it has no cargo, and its number is free again.
    await added(started, sklad, 189, line("70", 1000));
    expect((await deleteRequest(started, "/api/trips/191", sklad)).status).toBe(403);
    expect(await (await deleteRequest(started, "/api/trips/189", mudir)).json()).toEqual({ error: "trip_has_cargo" });
    expect((await detail(started, mudir, 191)).may.remove).toBe(true);
    expect(await (await deleteRequest(started, "/api/trips/191", mudir)).json()).toEqual({ deleted: true });
    expect((await get(started, "/api/trips/191", mudir)).status).toBe(404);
    expect(((await (await get(started, "/api/trips", mudir)).json()) as { trips: Array<{ number: number }>; nextNumber: number }).nextNumber).toBe(190);
    await trip(started, sklad, 191);
  });

  it("say one debt of a client in the cash desk and on the trips: what arrived, less what the cash book took in", async () => {
    const { started, mudir, sklad, ivan } = await business();
    await clients(started, mudir, [
      { code: "132", name: "Иброхим", priceMilli: 1500, openingDebtMinor: 20_000 },
      { code: "13", name: "Тёзка", priceMilli: 1500 },
      { code: "70", name: "Лочин", priceMilli: 1550, openingDebtMinor: -5_000 },
    ]);
    // Before any trip: what was owed at the start, and money paid ahead.
    expect(await debtOf(started, ivan, "132")).toEqual({ opening: 20_000, charged: 0, paid: 0, debt: 20_000 });
    expect(await debtOf(started, ivan, "70")).toEqual({ opening: -5_000, charged: 0, paid: 0, debt: -5_000 });

    await trip(started, sklad, 190);
    await added(started, sklad, 190, line("132", 3_686_500)); // 5 529,75 $
    await added(started, sklad, 190, line("70", 1_075_000)); // 1 666,25 $
    await trip(started, sklad, 191);
    await added(started, sklad, 191, line("132", 1_000_000)); // 1 500 $, still on the road
    await arrive(started, sklad, 190);
    expect((await status(started, sklad, 191, { status: "in_transit" })).status).toBe(200);
    expect(await debtOf(started, ivan, "132")).toEqual({ opening: 20_000, charged: 552_975, paid: 0, debt: 572_975 });

    // The cashier takes a payment in the cash desk: the form writes the client as the directory names them.
    const paid = await postJson(started, "/api/operations", payment("132", 300_000), ivan);
    expect(paid.status).toBe(201);
    expect(((await paid.json()) as { operation: { clientCode: string } }).operation.clientCode).toBe("132 Иброхим");
    expect((await postJson(started, "/api/operations", payment("132 Иброхим", 50_000, { kassa: "tashkent" }), mudir)).status).toBe(201);
    // A payment of 13 is not a payment of 132.
    expect((await postJson(started, "/api/operations", payment("13", 7_000), ivan)).status).toBe(201);
    // Money given back to the client is owed again; a deleted entry counts for nothing.
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "USD", category: "client_refund", clientCode: "132" }, ivan)).status).toBe(201);
    const mistake = payment("132", 99_900);
    expect((await postJson(started, "/api/operations", mistake, ivan)).status).toBe(201);
    expect((await deleteRequest(started, `/api/operations/${mistake.id as string}`, ivan)).status).toBe(200);

    const debt = { opening: 20_000, charged: 552_975, paid: 340_000, debt: 232_975 };
    expect(await debtOf(started, ivan, "132")).toEqual(debt);
    expect(await debtOf(started, sklad, "132")).toEqual(debt);
    expect((await debtOf(started, ivan, "13")).debt).toBe(-7_000);
    // The trips say the same debt of the same client, on whichever truck their cargo is.
    expect((await detail(started, sklad, 190)).clients.map((item) => [item.code, item.debtMinor])).toEqual([["70", 161_625], ["132", 232_975]]);
    expect((await detail(started, sklad, 191)).clients.map((item) => [item.code, item.debtMinor])).toEqual([["132", 232_975]]);

    // The second truck arrives: the debt grows by its cargo. A line taken off an arrived trip takes its debt along.
    expect((await status(started, sklad, 191, { status: "arrived", arrivalDay: "2026-09-01" })).status).toBe(200);
    expect((await debtOf(started, ivan, "132")).debt).toBe(382_975);
    const second = await detail(started, mudir, 191);
    expect((await deleteRequest(started, `/api/trips/191/cargo/${second.cargo[0]!.id}`, mudir)).status).toBe(200);
    expect((await debtOf(started, ivan, "132")).debt).toBe(232_975);

    // The admin sets what a kilogram costs the client and what they owed at the start.
    const changed = (await (await patchJson(started, "/api/admin/clients/132", { priceMilli: 1600, openingDebtMinor: 0 }, mudir)).json()) as { client: Json };
    expect(changed.client).toEqual({ code: "132", name: "Иброхим", phone: null, note: null, active: true, priceMilli: 1600, openingDebtMinor: 0, chargedMinor: 552_975, paidMinor: 340_000, debtMinor: 212_975 });
    expect(((await (await patchJson(started, "/api/admin/clients/132", { priceMilli: null }, mudir)).json()) as { client: Json }).client.priceMilli).toBeNull();
    expect((await patchJson(started, "/api/admin/clients/132", { priceMilli: -1 }, mudir)).status).toBe(400);
    const made = (await (await postJson(started, "/api/admin/clients", { code: "900", name: "Вали", priceMilli: 1700, openingDebtMinor: 1_000 }, mudir)).json()) as { client: Json };
    expect(made.client).toMatchObject({ code: "900", priceMilli: 1700, openingDebtMinor: 1_000, debtMinor: 1_000 });
  });

  it("count a payment in rubles at its rate, where the codes of the clients have the letter", async () => {
    const started = await startTestApp({ warehouses: parseWarehouses("andijan") });
    app = started;
    started.setNow(new Date("2026-08-01T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    await clients(started, mudir, [{ code: "А707", name: "Карим", priceMilli: 2000 }]);
    await trip(started, mudir, 5);
    await added(started, mudir, 5, line("а707", 500_000)); // 1 000 $
    await arrive(started, mudir, 5);
    // 39 500 rubles at 79 are 500 $; and 100 $ in dollars.
    expect((await postJson(started, "/api/operations", withRate({ id: randomUUID(), type: "income", amountMinor: 3_950_000, currency: "RUB", category: "client_payment", clientCode: "707" }), mudir)).status).toBe(201);
    expect((await postJson(started, "/api/operations", payment("А707 Карим", 10_000), mudir)).status).toBe(201);
    expect(await debtOf(started, mudir, "А707")).toEqual({ opening: 0, charged: 100_000, paid: 60_000, debt: 40_000 });
  });

  it("keep a line of the waybill column for column: the part of the truck with its turn there, the day, the receiver, the packaging", async () => {
    const { started, mudir, sklad } = await business();
    await clients(started, mudir, [{ code: "641", name: "Е Шерва", priceMilli: 1400 }, { code: "804", name: "Баходир", priceMilli: 1400 }]);
    const made = await trip(started, sklad, 248, { loadingDay: "2026-10-07", departureDay: "2026-10-08", direction: " АНДИЖОН - МОСКВА (через КЗХ) " });
    expect(made.trip).toMatchObject({ loadingDay: "2026-10-07", departureDay: "2026-10-08", direction: "АНДИЖОН - МОСКВА (через КЗХ)" });
    expect((await postJson(started, "/api/trips", { number: 249, loadingDay: "2026-11-31" }, sklad)).status).toBe(400);

    const head = (code: string, more: Json) => line(code, 100_000, { truckPart: "head", ...more });
    await added(started, sklad, 248, head("641", { acceptedDay: "2026-10-04", receiver: "Е Шерва", brand: "моднова", item: "Футболка мужская", bags: 138, packaging: "пэ меш", pieces: 21_167, sender: "Иномидин" }));
    await added(started, sklad, 248, line("804", 50_000, { truckPart: "trailer", bags: 51, receiver: "Бобур" }));
    await added(started, sklad, 248, head("804", { bags: 25 }));
    // The cargo of Kokand is numbered by itself, as the waybill writes «КУКОН ГОЛОВА 1»; a line that names no part has no turn.
    await added(started, sklad, 248, head("641", { warehouse: "kokand", bags: 9 }));
    const loaded = await added(started, sklad, 248, line("641", 10_000, { bags: 3 }));
    expect(loaded.cargo.map((item) => [item.warehouse, item.truckPart, item.place])).toEqual([
      ["andijan", "head", 1],
      ["andijan", "trailer", 1],
      ["andijan", "head", 2],
      ["kokand", "head", 1],
      ["andijan", null, null],
    ]);
    expect(loaded.cargo[0]).toMatchObject({ acceptedDay: "2026-10-04", receiver: "Е Шерва", clientName: "Е Шерва", packaging: "пэ меш", bags: 138, pieces: 21_167, sender: "Иномидин" });
    // The receiver is whoever the waybill names, under the code of the client who owes.
    expect(loaded.cargo[1]).toMatchObject({ receiver: "Бобур", clientCode: "804", clientName: "Баходир" });
    // The foot of the waybill: the places on the head and on the trailer.
    expect(loaded.places).toEqual({ head: 172, trailer: 51 });
    expect(loaded.trip).toMatchObject({ bags: 226, lines: 5 });

    // A correction says the whole line again: what it leaves out is emptied.
    const corrected = (await (await putJson(started, `/api/trips/248/cargo/${loaded.cargo[1]!.id}`, fields("804", 50_000, { truckPart: "head", packaging: "коробка" }), sklad)).json()) as Detail;
    expect(corrected.cargo[1]).toMatchObject({ truckPart: "head", place: 2, receiver: null, packaging: "коробка", bags: null });
    expect((await add(started, sklad, 248, line("641", 1000, { truckPart: "roof" }))).status).toBe(400);
    expect((await add(started, sklad, 248, line("641", 1000, { acceptedDay: "2026-02-30" }))).status).toBe(400);
    // The two days of the header are kept apart, and either may be taken away again.
    expect(((await (await patchJson(started, "/api/trips/248", { loadingDay: "2026-11-06", direction: null }, sklad)).json()) as Detail).trip).toMatchObject({ loadingDay: "2026-11-06", departureDay: "2026-10-08", direction: null });
  });

  describe("with the history of a card file", () => {
    /** A small card file: three clients, two trips of before with sums, payments in two cities, a trip on the road. */
    const history = (): HistoryFile => ({
      clients: [
        { code: "1", name: "Улугбек", openingDebtMinor: 2_439_800 },
        { code: "132", name: "Иброхим" },
        { code: "413", name: "Ахмад" },
      ],
      trips: [
        { number: 67, arrivalDay: "2026-01-03", sums: [{ code: "1", amountMicro: 2_894_850_000 }, { code: "132", amountMicro: 4_285_728_000, note: "перенесено с кода 13" }] },
        { number: 68, arrivalDay: "2026-02-06", sums: [{ code: "132", amountMicro: 1_000_004_000 }, { code: "413", amountMicro: 31_260_000 }] },
      ],
      payments: [
        { code: "1", day: "2026-01-05", amountMinor: 108_000, kassa: "moscow" },
        { code: "1", day: "2026-02-08", amountMinor: 100_000, kassa: "tashkent" },
        { code: "132", day: "2026-02-06", amountMinor: 300_000 },
        { code: "413", day: "2026-02-25", amountMinor: 3_100, kassa: "andijan", note: "оплата в Андижане" },
      ],
      waybills: [
        {
          number: 248, status: "in_transit", loadingDay: "2026-10-07", departureDay: "2026-10-08", direction: "АНДИЖОН - МОСКВА (через КЗХ)", driverName: "Икромжон", driverPhone: "+998947243232", truckPlates: "60 J531KB/508196BA",
          lines: [
            { warehouse: "andijan", truckPart: "head", acceptedDay: "2026-10-04", code: "132", receiver: "Иброхим", brand: "без эти", item: "Трусы мужская", bags: 51, packaging: "пэ меш", pieces: 15_300, weightG: 1_578_300, priceMilli: 1400, sender: "Кобилжон" },
            { warehouse: "kokand", truckPart: "head", code: "1", receiver: "Улугбек", weightG: 500_000, priceMilli: 1500 },
          ],
        },
      ],
      control: [
        { month: "2026-01", openingMinor: 2_439_800, chargedMinor: 718_058, paidMinor: 108_000, closingMinor: 3_049_858 },
        { month: "2026-02", openingMinor: 3_049_858, chargedMinor: 103_126, paidMinor: 403_100, closingMinor: 2_749_884 },
      ],
    });
    const settings = { warehouses: parseWarehouses("andijan,kokand,tashkent"), kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), clientCodes: "digits" as const };
    async function load(started: TestApp, file: HistoryFile) {
      const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 2 });
      try {
        return await importHistory(pool, file, settings);
      } finally {
        await pool.end();
      }
    }

    it("load the clients, the trips of before, the payments of before and the waybills on the road, and the debts are those of the file", async () => {
      const { started, mudir, owner, ivan, sklad } = await business();
      const report = await load(started, history());
      expect(report.clients).toEqual({ added: 3, there: 0 });
      expect(report.trips).toEqual({ added: 2, there: 0, removed: 0, sums: 4 });
      expect(report.payments).toBe(4);
      expect(report.waybills).toEqual([{ number: 248, lines: 2, note: "made" }]);
      // Month by month the debts are what the control sheet of the file says, to the cent.
      expect(report.control.map((month) => [month.month, month.openingMinor, month.chargedMinor, month.paidMinor, month.closingMinor])).toEqual([
        ["2026-01", 2_439_800, 718_058, 108_000, 3_049_858],
        ["2026-02", 3_049_858, 103_126, 403_100, 2_749_884],
      ]);
      expect(report.control.every((month) => month.file?.closingMinor === month.closingMinor)).toBe(true);
      expect(await (await get(started, "/api/debts/control?year=2026", owner)).json()).toEqual({ year: 2026, months: report.control.map(({ file: _file, ...month }) => month) });

      // A sum with a third decimal is owed to the nearest cent: 4 285,728 is 4 285,73, and 1 000,004 is 1 000,00.
      expect(await debtOf(started, ivan, "132")).toEqual({ opening: 0, charged: 528_573, paid: 300_000, debt: 228_573 });
      expect(await debtOf(started, ivan, "1")).toEqual({ opening: 2_439_800, charged: 289_485, paid: 208_000, debt: 2_521_285 });
      expect(await debtOf(started, ivan, "413")).toEqual({ opening: 0, charged: 3_126, paid: 3_100, debt: 26 });

      // The trips of before are there as arrived, with the sum of each client and no waybill; nobody writes cargo onto them.
      const list = (await (await get(started, "/api/trips", owner)).json()) as { trips: Array<{ number: number; status: string; fromCardFile: boolean; amountMinor: number; arrivalDay: string | null; lines: number }> };
      expect(list.trips.map((item) => [item.number, item.status, item.fromCardFile, item.amountMinor, item.lines])).toEqual([
        [248, "in_transit", false, 295_962, 2],
        [68, "arrived", true, 103_126, 0],
        [67, "arrived", true, 718_058, 0],
      ]);
      const old = await detail(started, mudir, 67);
      expect(old.cargo).toEqual([]);
      expect(old.clients).toEqual([
        { code: "1", name: "Улугбек", bags: 0, weightG: 0, amountMinor: 289_485, debtMinor: 2_521_285 },
        { code: "132", name: "Иброхим", bags: 0, weightG: 0, amountMinor: 428_573, debtMinor: 228_573 },
      ]);
      expect(old.may).toMatchObject({ warehouses: [], remove: false });
      expect(await (await add(started, mudir, 67, line("132", 1000, { priceMilli: 1500 }))).json()).toEqual({ error: "trip_from_card_file" });
      expect(await (await deleteRequest(started, "/api/trips/67", mudir)).json()).toEqual({ error: "trip_has_cargo" });

      // The trip on the road has its whole waybill, and is owed for when it arrives, like any trip kept here.
      const road = await detail(started, sklad, 248);
      expect(road.trip).toMatchObject({ status: "in_transit", loadingDay: "2026-10-07", departureDay: "2026-10-08", driverName: "Икромжон", truckPlates: "60 J531KB/508196BA", direction: "АНДИЖОН - МОСКВА (через КЗХ)" });
      expect(road.cargo.map((item) => [item.warehouse, item.truckPart, item.place, item.clientCode, item.amountMinor])).toEqual([["andijan", "head", 1, "132", 220_962], ["kokand", "head", 1, "1", 75_000]]);
      expect(road.cargo[0]).toMatchObject({ acceptedDay: "2026-10-04", receiver: "Иброхим", packaging: "пэ меш", bags: 51, pieces: 15_300, sender: "Кобилжон", mine: true });
      started.setNow(new Date("2026-10-20T09:00:00Z"));
      expect((await status(started, sklad, 248, { status: "arrived", arrivalDay: "2026-10-20" })).status).toBe(200);
      expect((await debtOf(started, ivan, "132")).debt).toBe(228_573 + 220_962);

      // The payments of before are in no cash desk: no balance has moved, and the journal has none of them.
      expect(await (await get(started, "/api/balances?kassa=moscow", mudir)).json()).toEqual({ balances: [{ currency: "USD", amountMinor: 0 }] });
      expect(((await (await get(started, "/api/operations?from=2026-01-01&to=2026-12-31", mudir)).json()) as { operations: unknown[] }).operations).toEqual([]);
    });

    it("show the card of a client: every trip and every payment since the start, with the debt after each", async () => {
      const { started, mudir, owner, ivan, sklad } = await business();
      await load(started, history());
      // A payment taken in the cash desk today, and money given back: entries of the cash book, on the same card.
      started.setNow(new Date("2026-10-17T09:00:00Z"));
      expect((await postJson(started, "/api/operations", payment("1", 50_000, { kassa: "moscow" }), mudir)).status).toBe(201);
      started.setNow(new Date("2026-10-17T09:05:00Z"));
      expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 2_000, currency: "USD", category: "client_refund", clientCode: "1", kassa: "moscow" }, mudir)).status).toBe(201);

      const card = (await (await get(started, "/api/clients/1/statement", owner)).json()) as Json;
      expect(card).toEqual({
        code: "1",
        name: "Улугбек",
        openingDebtMinor: 2_439_800,
        movements: [
          { day: "2026-01-03", kind: "trip", tripNumber: 67, amountMinor: 289_485, kassa: null, past: false, note: null, debtMinor: 2_729_285 },
          { day: "2026-01-05", kind: "payment", tripNumber: null, amountMinor: 108_000, kassa: "moscow", past: true, note: null, debtMinor: 2_621_285 },
          { day: "2026-02-08", kind: "payment", tripNumber: null, amountMinor: 100_000, kassa: "tashkent", past: true, note: null, debtMinor: 2_521_285 },
          { day: "2026-10-17", kind: "payment", tripNumber: null, amountMinor: 50_000, kassa: "moscow", past: false, note: null, debtMinor: 2_471_285 },
          { day: "2026-10-17", kind: "refund", tripNumber: null, amountMinor: 2_000, kassa: "moscow", past: false, note: null, debtMinor: 2_473_285 },
        ],
        debtMinor: 2_473_285,
      });
      // On the day a trip arrives it comes before the payment of that day; a payment of the history says its note.
      const other = (await (await get(started, "/api/clients/132/statement", mudir)).json()) as { movements: Array<{ day: string; kind: string; note: string | null }> };
      expect(other.movements.map((line) => [line.day, line.kind])).toEqual([["2026-01-03", "trip"], ["2026-02-06", "trip"], ["2026-02-06", "payment"]]);
      expect(((await (await get(started, "/api/clients/413/statement", mudir)).json()) as { movements: Array<{ note: string | null }> }).movements[1]!.note).toBe("оплата в Андижане");
      // The card is the owner's and the admin's to look into.
      for (const cookie of [ivan, sklad]) expect((await get(started, "/api/clients/1/statement", cookie)).status).toBe(403);
      expect((await get(started, "/api/debts/control", ivan)).status).toBe(403);
      expect((await get(started, "/api/clients/999/statement", mudir)).status).toBe(404);
    });

    it("load a file that was put right again without doubling anything, and leave alone what was entered here since", async () => {
      const { started, mudir, ivan, sklad } = await business();
      await load(started, history());
      started.setNow(new Date("2026-10-17T09:00:00Z"));
      expect((await postJson(started, "/api/operations", payment("132", 28_573), ivan)).status).toBe(201);
      await trip(started, sklad, 252);
      await added(started, sklad, 252, line("132", 100_000, { priceMilli: 1500 }));

      // The file again, put right: a sum changed, a trip gone, a payment more, a client more.
      const again = history();
      again.clients.push({ code: "70", name: "Лочин", openingDebtMinor: -5_000 });
      again.trips[0]!.sums[1]!.amountMicro = 4_000_000_000;
      again.trips.pop();
      again.payments.push({ code: "70", day: "2026-03-01", amountMinor: 1_000 });
      delete again.control;
      const report = await load(started, again);
      expect(report.clients).toEqual({ added: 1, there: 3 });
      expect(report.trips).toEqual({ added: 0, there: 1, removed: 1, sums: 2 });
      expect(report.payments).toBe(5);
      expect(report.waybills).toEqual([{ number: 248, lines: 0, note: "left as it is: it has 2 lines already" }]);
      expect(await debtOf(started, ivan, "132")).toEqual({ opening: 0, charged: 400_000, paid: 328_573, debt: 71_427 });
      expect(await debtOf(started, ivan, "70")).toEqual({ opening: -5_000, charged: 0, paid: 1_000, debt: -6_000 });
      const numbers = ((await (await get(started, "/api/trips", mudir)).json()) as { trips: Array<{ number: number }> }).trips.map((item) => item.number);
      expect(numbers).toEqual([252, 248, 67]);
      expect((await detail(started, mudir, 248)).cargo).toHaveLength(2);
      expect((await detail(started, mudir, 252)).cargo).toHaveLength(1);
    });

    it("refuse a file that cannot be right, whole, and say what is wrong with it", async () => {
      const { started, sklad } = await business();
      const broken = history();
      broken.clients.push({ code: "584", name: " " }, { code: "", name: "Без кода" });
      broken.trips[0]!.arrivalDay = "2026-02-30";
      broken.payments[0]!.kassa = "kokand";
      broken.waybills![0]!.lines[0]!.warehouse = "moscow";
      const refused = await load(started, broken).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AdminError);
      const said = (refused as Error).message;
      for (const part of ["(584): a client has a name", 'clients[4]: "" is not a code', 'trip 67: "2026-02-30" is not the day it arrived', '"kokand" is not a cash desk', '"moscow" is not a warehouse']) expect(said).toContain(part);
      // Somebody the file and the directory do not have; and a trip that is kept here under the same number.
      const stranger = history();
      stranger.payments.push({ code: "999", day: "2026-03-01", amountMinor: 1_000 });
      await expect(load(started, stranger)).rejects.toThrow(/neither in it nor in the directory: 999/);
      await clients(started, await loginAs(started, "mudir", "admin password"), [{ code: "132", name: "Иброхим", priceMilli: 1500 }]);
      await trip(started, sklad, 67);
      await expect(load(started, history())).rejects.toThrow(/kept here already, with waybills of their own: 67/);
      // Nothing of a refused file is in the database.
      expect(await started.query("SELECT (SELECT count(*)::int FROM past_payments) AS payments, (SELECT count(*)::int FROM trip_sums) AS sums")).toEqual([{ payments: 0, sums: 0 }]);
    });
  });

  it("show the owner and the admin what the cash desk spent on a trip, and nobody else", async () => {
    const { started, mudir, owner, sklad } = await business();
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, sklad, 190);
    await added(started, sklad, 190, line("70", 1_000_000)); // 1 500 $
    expect((await patchJson(started, "/api/admin/categories/customs", { requiresTrip: true }, mudir)).status).toBe(200);
    const expense = (tripNumber: number, amountMinor: number) => ({ id: randomUUID(), type: "expense", amountMinor, currency: "USD", category: "customs", tripNumber });
    expect((await postJson(started, "/api/operations", expense(190, 40_000), mudir)).status).toBe(201);
    expect((await postJson(started, "/api/operations", expense(190, 2_500), mudir)).status).toBe(201);
    expect((await postJson(started, "/api/operations", expense(191, 9_900), mudir)).status).toBe(201);
    expect((await detail(started, owner, 190)).money).toEqual({ expenseMinor: 42_500, profitMinor: 107_500 });
    expect((await detail(started, mudir, 190)).money).toEqual({ expenseMinor: 42_500, profitMinor: 107_500 });
    expect((await detail(started, sklad, 190)).money).toBeUndefined();
  });

  it("keep the keeper of a warehouse out of the cash: its balances, its journal, its lists", async () => {
    const { started, mudir, sklad, andijan } = await business();
    for (const path of ["/api/balances", "/api/operations", "/api/categories", "/api/client-codes", "/api/operations/defaults", "/api/summary", "/api/reconciliations", "/api/cashiers", "/api/admin/users"]) {
      expect((await get(started, path, sklad)).status, path).toBe(403);
      // Andijan is a cash desk too: its keeper of the warehouse is no cashier of it.
      expect((await get(started, path, andijan)).status, path).toBe(403);
    }
    expect((await postJson(started, "/api/operations", payment("70", 1000), sklad)).status).toBe(403);
    // What they do need: who they are, the names of the places, the clients.
    const me = (await (await get(started, "/api/me", andijan)).json()) as { user: Json };
    expect(me.user).toMatchObject({ login: "anvar", role: "warehouse", city: "andijan" });
    for (const path of ["/api/kassas", "/api/warehouses", "/api/clients", "/api/trips"]) expect((await get(started, path, sklad)).status, path).toBe(200);
    expect((await get(started, "/api/balances", mudir)).status).toBe(200);
  });

  it("place a keeper at a warehouse and anybody else at a cash desk, and keep whoever wrote cargo in the list of people", async () => {
    const { started, mudir, kokand } = await business();
    const users = async () => (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ id: string; login: string; role: string; city: string | null; hasEntries: boolean }>;
    const idOf = async (login: string) => (await users()).find((user) => user.login === login)!.id;
    // Kokand is a warehouse and no cash desk; Moscow is a cash desk and no warehouse.
    expect(await (await postJson(started, "/api/admin/users", { login: "kassir", password: "some long pass", role: "cashier", city: "kokand" }, mudir)).json()).toEqual({ error: "bad_city" });
    expect(await (await postJson(started, "/api/admin/users", { login: "sklad2", password: "some long pass", role: "warehouse", city: "moscow" }, mudir)).json()).toEqual({ error: "bad_city" });
    expect((await postJson(started, "/api/admin/users", { login: "sklad2", password: "some long pass", role: "warehouse", city: "tashkent" }, mudir)).status).toBe(201);

    // A keeper who becomes a cashier needs a cash desk for a city, said in the same change.
    const qodir = await idOf("qodir");
    expect(await (await patchJson(started, `/api/admin/users/${qodir}`, { role: "cashier" }, mudir)).json()).toEqual({ error: "bad_city" });
    expect((await patchJson(started, `/api/admin/users/${qodir}`, { city: "moscow" }, mudir)).status).toBe(400);
    expect((await patchJson(started, `/api/admin/users/${qodir}`, { city: "tashkent" }, mudir)).status).toBe(200);

    // Whoever made a trip or wrote a line is named in its history: blocked, never deleted.
    await clients(started, mudir, [{ code: "70", name: "Лочин", priceMilli: 1500 }]);
    await trip(started, mudir, 190);
    expect((await users()).find((user) => user.login === "qodir")!.hasEntries).toBe(false);
    expect((await add(started, kokand, 190, line("70", 1000, { warehouse: "tashkent" }))).status).toBe(201);
    expect((await users()).find((user) => user.login === "qodir")!.hasEntries).toBe(true);
    expect(await (await deleteRequest(started, `/api/admin/users/${qodir}`, mudir)).json()).toEqual({ error: "has_entries" });
    expect((await deleteRequest(started, `/api/admin/users/${await idOf("sklad2")}`, mudir)).status).toBe(204);
  });
});
