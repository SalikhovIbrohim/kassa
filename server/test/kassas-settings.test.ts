import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { AdminError } from "../src/admin/users.js";
import { loadConfig } from "../src/config.js";
import { parseKassas } from "../src/kassa.js";
import { assertKassasCoverDatabase, outsideSettings } from "../src/kassa-check.js";
import { migrate } from "../src/migrate.js";
import { threadOf } from "../src/outbox.js";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { KEYS, startFakeOneC, type FakeOneC } from "./helpers/fake-onec.js";
import { startFakeTelegram, type FakeTelegram } from "./helpers/fake-telegram.js";
import { createBlankDatabase, startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

type Entry = Record<string, unknown>;

/** The setting of a business with three desks that all keep dollars only. */
const THREE_DESKS = "moscow:USD,andijan:USD,tashkent:USD";

describe("the cash desks named in the settings (KASSAS)", () => {
  it("are Moscow in rubles and dollars and Andijan in dollars when the settings say nothing", () => {
    for (const setting of [undefined, "", "   "]) {
      const kassas = parseKassas(setting);
      expect(kassas.list).toEqual([
        { id: "moscow", label: "Москва", short: "МСК", currencies: ["RUB", "USD"] },
        { id: "andijan", label: "Андижан", short: "АНД", currencies: ["USD"] },
      ]);
      expect(kassas.primary).toBe("moscow");
      expect(kassas.currencies).toEqual(["RUB", "USD"]);
    }
  });

  it("are read from the setting: a city the code knows by itself, any other with its name", () => {
    const three = parseKassas(" moscow:USD, andijan:usd ,tashkent:USD ");
    expect(three.list).toEqual([
      { id: "moscow", label: "Москва", short: "МСК", currencies: ["USD"] },
      { id: "andijan", label: "Андижан", short: "АНД", currencies: ["USD"] },
      { id: "tashkent", label: "Ташкент", short: "ТШК", currencies: ["USD"] },
    ]);
    expect(three.primary).toBe("moscow");
    expect(three.currencies).toEqual(["USD"]);
    expect(three.currenciesOf("tashkent")).toEqual(["USD"]);

    // The first desk named is the main one; the currencies are kept rubles first, however they were written.
    const own = parseKassas("fergana=Фергана:USD+RUB,moscow=Склад в Москве:RUB");
    expect(own.list).toEqual([
      { id: "fergana", label: "Фергана", short: "ФЕР", currencies: ["RUB", "USD"] },
      { id: "moscow", label: "Склад в Москве", short: "СКЛ", currencies: ["RUB"] },
    ]);
    expect(own.primary).toBe("fergana");
  });

  it("refuses a setting that cannot be right, and says what is wrong with it", () => {
    const bad: Array<[string, RegExp]> = [
      [",", /names no cash desk/],
      ["moscow", /not id:CURRENCY/],
      ["Moscow:USD", /not id:CURRENCY/],
      ["moscow:EUR", /the currency "EUR"/],
      ["moscow:USD+USD", /a currency twice/],
      ["moscow:USD,moscow:RUB", /"moscow" twice/],
      ["samarkand:USD", /no name for: write it as samarkand=Название:USD/],
      ["income:USD", /cannot name a cash desk "income"/],
      ["both=Обе:USD", /cannot name a cash desk "both"/],
      ["constructor=Стройка:USD", /cannot name a cash desk "constructor"/],
      ["fergana=\uFFFD\uFFFD\uFFFD:USD", /cannot be read: save the settings file as UTF-8/],
      ["fergana= :USD", /not id:CURRENCY|empty/],
      [Array.from({ length: 13 }, (_, index) => `d${index}=Касса ${index}:USD`).join(","), /more than 12/],
    ];
    for (const [setting, message] of bad) {
      expect(() => parseKassas(setting), setting).toThrow(message);
      expect(() => parseKassas(setting), setting).toThrow(/^KASSAS /);
    }
  });

  it("say who works where: a person of a city in its desk only, a person of everywhere in any, nobody in a desk that is not there", () => {
    const kassas = parseKassas(THREE_DESKS);
    expect(kassas.mayUse("tashkent", "tashkent")).toBe(true);
    expect(kassas.mayUse("tashkent", "moscow")).toBe(false);
    expect(kassas.mayUse(null, "tashkent")).toBe(true);
    expect(kassas.defaultOf("tashkent")).toBe("tashkent");
    expect(kassas.defaultOf(null)).toBe("moscow");
    // A person whose city was taken out of the settings works nowhere until the admin gives them another.
    const two = parseKassas("moscow:USD,tashkent:USD");
    expect(two.mayUse("andijan", two.defaultOf("andijan"))).toBe(false);
    expect(two.has("andijan")).toBe(false);
    expect(two.has("toString")).toBe(false);
  });

  it("know which desks nothing but the name tells apart: those that keep the same money", () => {
    // Moscow keeps rubles too, so a count of dollars only is Andijan's: no name is needed, and none was ever said.
    const two = parseKassas(undefined);
    expect([two.alike("moscow"), two.alike("andijan")]).toEqual([false, false]);
    const three = parseKassas(THREE_DESKS);
    expect(three.ids.map((id) => three.alike(id))).toEqual([true, true, true]);
    const mixed = parseKassas("moscow:RUB+USD,andijan:USD,tashkent:USD");
    expect(mixed.ids.map((id) => mixed.alike(id))).toEqual([false, true, true]);
    expect(three.alike("samarkand")).toBe(false);
  });
});

describe("the settings that are set per cash desk", () => {
  const base = { DATABASE_URL: "postgres://kassa:secret@localhost:5432/kassa" };
  const OTHER_KASSA = "7a1e52c0-924a-11f1-8cb7-b8cb29f61f4c";
  const onec = {
    ...base,
    KASSAS: THREE_DESKS,
    ONEC_MODE: "live",
    ONEC_ODATA_URL: "http://1c.example/base",
    ONEC_ODATA_USER: "robot",
    ONEC_ODATA_PASSWORD: "s3cret",
    ONEC_ORGANIZATION_KEY: KEYS.organization,
    ONEC_KASSA_KEY: KEYS.kassa,
    ONEC_CURRENCY_KEY: KEYS.currency,
  };

  it("are as they were for a settings file that names no desks", () => {
    const config = loadConfig({ ...base, TELEGRAM_THREAD_INCOME: "3", TELEGRAM_THREAD_EXPENSE: "5", TELEGRAM_THREAD_ANDIJAN: "7" });
    expect(config.kassas.ids).toEqual(["moscow", "andijan"]);
    expect(config).toMatchObject({ telegramIncomeThreadId: 3, telegramExpenseThreadId: 5, telegramKassaThreadIds: { andijan: 7 }, onecKassas: ["moscow"] });
    expect(loadConfig(base).telegramKassaThreadIds).toEqual({});
  });

  it("name the topic of the Telegram group of a desk after its id", () => {
    const config = loadConfig({ ...base, KASSAS: THREE_DESKS, TELEGRAM_THREAD_TASHKENT: "9", TELEGRAM_THREAD_ANDIJAN: " 7 " });
    expect(config.kassas.ids).toEqual(["moscow", "andijan", "tashkent"]);
    expect(config.telegramKassaThreadIds).toEqual({ andijan: 7, tashkent: 9 });
    expect(() => loadConfig({ ...base, KASSAS: THREE_DESKS, TELEGRAM_THREAD_TASHKENT: "nine" })).toThrow(/TELEGRAM_THREAD_TASHKENT must be the number of the topic/);
    expect(() => loadConfig({ ...base, KASSAS: "moscow:EUR" })).toThrow(/^KASSAS /);
  });

  it("send a desk with a topic of its own there, the main desk by kind, and any other desk to the main topic", () => {
    const settings = { incomeThreadId: 3, expenseThreadId: 5, kassaThreadIds: { tashkent: 9 } };
    const topic = (kind: "income" | "expense" | "general", kassa: string) => threadOf(settings, "moscow", { kind, kassa });
    expect([topic("income", "moscow"), topic("expense", "moscow"), topic("general", "moscow")]).toEqual([3, 5, undefined]);
    expect([topic("income", "tashkent"), topic("expense", "tashkent"), topic("general", "tashkent")]).toEqual([9, 9, 9]);
    expect([topic("income", "andijan"), topic("expense", "andijan"), topic("general", "andijan")]).toEqual([undefined, undefined, undefined]);
    // The main desk with a topic of its own tells everything there too.
    expect(threadOf({ ...settings, kassaThreadIds: { moscow: 11 } }, "moscow", { kind: "income", kassa: "moscow" })).toBe(11);
    // A group without topics: everything in the one chat.
    expect(threadOf({}, "moscow", { kind: "income", kassa: "moscow" })).toBeUndefined();
  });

  it("name the desks whose payments go to 1C, and the cash desk in the base of a desk that has its own", () => {
    // Nothing said: the main desk only, to the one cash desk of the base, as before.
    const plain = loadConfig(onec);
    expect(plain.onecKassas).toEqual(["moscow"]);
    expect(plain.onec).toMatchObject({ kassaKey: KEYS.kassa });
    expect(plain.onec).not.toHaveProperty("kassaKeys");

    const two = loadConfig({ ...onec, ONEC_KASSAS: "moscow, Tashkent", ONEC_KASSA_KEY_TASHKENT: OTHER_KASSA.toUpperCase() });
    expect(two.onecKassas).toEqual(["moscow", "tashkent"]);
    expect(two.onec).toMatchObject({ kassaKey: KEYS.kassa, kassaKeys: { tashkent: OTHER_KASSA } });

    // Which desks go to 1C is known while the writing is off, too: the journal of the admin says it.
    expect(loadConfig({ ...base, ONEC_KASSAS: "andijan" }).onecKassas).toEqual(["andijan"]);
  });

  it("say so when a setting is named after a desk that is not one: a topic in the log, a key of 1C by not starting", () => {
    // A topic of a desk that is not there sends nothing to a wrong place: the messages go to the main topic, and the log says why.
    const slip = loadConfig({ ...base, KASSAS: THREE_DESKS, TELEGRAM_THREAD_TASHKNET: "9", TELEGRAM_THREAD_INCOME: "3" });
    expect(slip.telegramKassaThreadIds).toEqual({});
    expect(slip.warnings).toEqual([expect.stringMatching(/^TELEGRAM_THREAD_TASHKNET is not used: the cash desks are moscow, andijan, tashkent/)]);
    expect(loadConfig({ ...base, TELEGRAM_THREAD_INCOME: "3", TELEGRAM_THREAD_EXPENSE: "5", TELEGRAM_THREAD_ANDIJAN: "7" }).warnings).toEqual([]);
    // In an installation that has no Tashkent its topic is such a slip too.
    expect(loadConfig({ ...base, TELEGRAM_THREAD_TASHKENT: "9" }).warnings).toHaveLength(1);

    // A key of 1C under a wrong name would send the receipts of that desk to the cash desk of another: no start.
    expect(() => loadConfig({ ...onec, ONEC_KASSAS: "moscow,tashkent", ONEC_KASSA_KEY_TASHKNET: OTHER_KASSA })).toThrow(
      /ONEC_KASSA_KEY_TASHKNET names no cash desk of KASSAS \(moscow, andijan, tashkent\)/,
    );
    // While the writing is off the keys are not looked at at all, as before.
    expect(loadConfig({ ...base, ONEC_KASSA_KEY_TASHKNET: OTHER_KASSA }).onec).toBeUndefined();
  });

  it("refuse a desk of 1C that is not a desk, and a key of a desk that is not written", () => {
    expect(() => loadConfig({ ...onec, ONEC_KASSAS: "samarkand" })).toThrow(/ONEC_KASSAS must list cash desks of KASSAS \(moscow, andijan, tashkent\), got "samarkand"/);
    expect(() => loadConfig({ ...onec, ONEC_KASSA_KEY_TASHKENT: OTHER_KASSA })).toThrow(/ONEC_KASSA_KEY_TASHKENT is set, but the payments of the cash desk tashkent are not written to 1C/);
    expect(() => loadConfig({ ...onec, ONEC_KASSAS: "tashkent", ONEC_KASSA_KEY_TASHKENT: "not-a-key" })).toThrow(/ONEC_KASSA_KEY_TASHKENT must be a key/);
  });
});

/**
 * Another business on the same code: three desks (Moscow, Andijan, Tashkent), all of dollars only. Nothing but the
 * settings of the installation says so.
 */
describe("an installation of three desks of dollars", () => {
  let app: TestApp | undefined;
  let telegram: FakeTelegram | undefined;
  let onec: FakeOneC | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await telegram?.close();
    telegram = undefined;
    await onec?.close();
    onec = undefined;
  });

  async function desk(options: Parameters<typeof startTestApp>[0] = {}) {
    const started = await startTestApp({ kassas: parseKassas(THREE_DESKS), ...options });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "timur", password: "tashkent cashier", role: "cashier", displayName: "Тимур" });
    await started.admin.createUser({ login: "ali", password: "andijan cashier", role: "cashier", displayName: "Али" });
    await started.admin.createUser({ login: "sardor", password: "tashkent counter", role: "head_cashier", displayName: "Сардор" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const users = (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ id: string; login: string }>;
    const setCity = async (login: string, city: string) =>
      expect((await patchJson(started, `/api/admin/users/${users.find((user) => user.login === login)!.id}`, { city }, mudir)).status).toBe(200);
    await setCity("timur", "tashkent");
    await setCity("ali", "andijan");
    await setCity("sardor", "tashkent");
    return {
      started,
      mudir,
      timur: await loginAs(started, "timur", "tashkent cashier"),
      ali: await loginAs(started, "ali", "andijan cashier"),
      sardor: await loginAs(started, "sardor", "tashkent counter"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const dollars = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 2_000, currency: "USD", category: "fuel_road", ...overrides });
  const payment = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 30_000, currency: "USD", category: "client_payment", clientCode: "А406 Жавид", ...overrides });
  const rubles = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  const post = (started: TestApp, cookie: string, body: Entry) => postJson(started, "/api/operations", body, cookie);
  const balances = async (started: TestApp, cookie: string, query = "") =>
    ((await (await get(started, `/api/balances${query}`, cookie)).json()) as { balances: Array<{ currency: string; amountMinor: number }> }).balances;

  it("tells the screens its desks: what each is called, what it keeps, whether it goes to 1C", async () => {
    const { started, ali } = await desk();

    expect((await get(started, "/api/kassas")).status).toBe(401);
    expect(await (await get(started, "/api/kassas", ali)).json()).toEqual({
      kassas: [
        { id: "moscow", label: "Москва", short: "МСК", currencies: ["USD"], onec: true },
        { id: "andijan", label: "Андижан", short: "АНД", currencies: ["USD"], onec: false },
        { id: "tashkent", label: "Ташкент", short: "ТШК", currencies: ["USD"], onec: false },
      ],
    });
  });

  it("books each cashier's entries in the desk of their city, and keeps the three balances apart, in dollars", async () => {
    const { started, timur, ali, mudir } = await desk();
    await started.admin.setOpeningBalance("USD", "100", "tashkent");
    await started.admin.setOpeningBalance("USD", "50");

    const spent = await post(started, timur, dollars());
    expect(spent.status).toBe(201);
    const saved = await spent.json();
    expect(saved.operation.kassa).toBe("tashkent");
    expect(saved.balances).toEqual([{ currency: "USD", amountMinor: 8_000 }]);
    expect((await (await post(started, ali, payment())).json()).operation.kassa).toBe("andijan");
    // A person of everywhere who names no desk writes to the main one, the first of the settings.
    expect((await (await post(started, mudir, dollars({ amountMinor: 500 }))).json()).operation.kassa).toBe("moscow");

    expect(await balances(started, timur)).toEqual([{ currency: "USD", amountMinor: 8_000 }]);
    expect(await balances(started, ali)).toEqual([{ currency: "USD", amountMinor: 30_000 }]);
    // Moscow keeps no rubles here: its balance has no line of them.
    expect(await balances(started, mudir)).toEqual([{ currency: "USD", amountMinor: 4_500 }]);
    expect(await balances(started, mudir, "?kassa=tashkent")).toEqual(await balances(started, timur));
  });

  it("takes no rubles in any desk, and lets nobody into the desk of another city", async () => {
    const { started, timur, mudir } = await desk();

    const refused = async (response: Response) => [response.status, ((await response.json()) as { message?: string; error?: string }).message ?? ""];
    const notKept = [400, "body/currency is not kept by this cash desk"];
    // The same entries in dollars are taken (see the test before): it is the rubles that are refused, in every desk.
    expect(await refused(await post(started, timur, rubles()))).toEqual(notKept);
    expect(await refused(await post(started, mudir, rubles({ kassa: "moscow" })))).toEqual(notKept);
    expect(await refused(await post(started, mudir, rubles()))).toEqual(notKept);
    expect((await post(started, timur, dollars({ kassa: "andijan" }))).status).toBe(403);
    expect(await refused(await post(started, timur, dollars({ kassa: "samarkand" })))).toEqual([400, expect.stringContaining("body/kassa must be equal to one of the allowed values")]);
    expect((await get(started, "/api/balances?kassa=moscow", timur)).status).toBe(403);
    expect((await get(started, "/api/operations?kassa=andijan", timur)).status).toBe(403);
    expect((await get(started, "/api/operations", timur)).status).toBe(200);

    // A correction does not turn an entry into rubles either.
    const body = dollars();
    expect((await post(started, timur, body)).status).toBe(201);
    expect(await refused(await putJson(started, `/api/operations/${body.id}`, { ...body, id: undefined, currency: "RUB" }, timur))).toEqual([
      400,
      "body/currency is not kept by the cash desk of this entry",
    ]);
    expect((await putJson(started, `/api/operations/${body.id}`, { ...body, id: undefined, amountMinor: 2_100 }, timur)).status).toBe(200);
    // Nor does an opening balance start in a currency the desk does not keep.
    await expect(started.admin.setOpeningBalance("RUB", "10")).rejects.toThrow(AdminError);
    await expect(started.admin.setOpeningBalance("RUB", "10", "tashkent")).rejects.toThrow(/does not keep RUB: it keeps USD/);
  });

  it("starts the form of a new person in dollars", async () => {
    const { started, timur } = await desk();
    expect(await (await get(started, "/api/operations/defaults", timur)).json()).toEqual({ currency: "USD" });
  });

  it("has Tashkent among the cities of people and of categories", async () => {
    const { started, mudir, timur, ali } = await desk();

    const users = (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ login: string; city: string | null }>;
    expect(users.find((user) => user.login === "timur")?.city).toBe("tashkent");
    expect((await (await get(started, "/api/me", timur)).json()).user.city).toBe("tashkent");

    const made = await postJson(started, "/api/admin/categories", { kind: "expense", label: "Склад Ташкент", city: "tashkent" }, mudir);
    expect(made.status).toBe(201);
    const code = (await made.json()).category.code as string;
    const offered = async (cookie: string) => ((await (await get(started, "/api/categories", cookie)).json()).categories as Array<{ code: string }>).map((item) => item.code);
    expect(await offered(timur)).toContain(code);
    expect(await offered(ali)).not.toContain(code);
    // A city that is not a desk of this business is not one of its cities.
    expect((await postJson(started, "/api/admin/categories", { kind: "expense", label: "Самарканд", city: "samarkand" }, mudir)).status).toBe(400);
  });

  it("adds up the totals of every desk in dollars only, and shows each cashier the journal of their desk", async () => {
    const { started, timur, ali, mudir, owner } = await desk();
    const there = payment();
    const here = payment({ amountMinor: 10_000 });
    const main = dollars();
    await post(started, timur, there);
    await post(started, ali, here);
    await post(started, mudir, main);

    const summary = async (query: string) =>
      (await (await get(started, `/api/summary${query}`, owner)).json()).currencies as Array<{ currency: string; incomeMinor: number; closingMinor: number }>;
    expect(await summary("")).toMatchObject([{ currency: "USD", incomeMinor: 40_000, closingMinor: 38_000 }]);
    expect(await summary("?kassa=tashkent")).toMatchObject([{ currency: "USD", incomeMinor: 30_000, closingMinor: 30_000 }]);
    expect(await summary("?kassa=moscow")).toMatchObject([{ currency: "USD", incomeMinor: 0, closingMinor: -2_000 }]);

    const ids = async (cookie: string, query = "") =>
      ((await (await get(started, `/api/operations${query}`, cookie)).json()).operations as Array<{ id: string }>).map((operation) => operation.id);
    expect(await ids(timur)).toEqual([there.id]);
    expect(await ids(ali)).toEqual([here.id]);
    expect(await ids(owner, "?kassa=moscow")).toEqual([main.id]);
    expect((await ids(owner)).sort()).toEqual([there.id, here.id, main.id].sort());
  });

  it("lets a head cashier count their desk, in dollars only, and the count moves that desk alone", async () => {
    const { started, timur, ali, sardor, owner } = await desk();
    await post(started, timur, payment());
    await post(started, ali, payment());
    const count = (body: Entry) => postJson(started, "/api/reconciliations", { id: randomUUID(), ...body }, sardor);

    expect((await count({ counted: [{ currency: "RUB", amountMinor: 0 }, { currency: "USD", amountMinor: 0 }] })).status).toBe(400);
    expect((await count({ counted: [{ currency: "USD", amountMinor: 700 }], cardMinor: 100 })).status).toBe(400);
    expect((await count({ kassa: "moscow", counted: [{ currency: "USD", amountMinor: 700 }] })).status).toBe(403);
    const made = await count({ counted: [{ currency: "USD", amountMinor: 29_500 }] });
    expect(made.status).toBe(201);
    const body = await made.json();
    expect(body.reconciliation).toMatchObject({ kassa: "tashkent", currencies: [{ currency: "USD", calculatedMinor: 30_000, actualMinor: 29_500, differenceMinor: -500 }] });
    expect(body.balances).toEqual([{ currency: "USD", amountMinor: 29_500 }]);

    expect(await balances(started, ali)).toEqual([{ currency: "USD", amountMinor: 30_000 }]);
    const listed = async (query: string) => ((await (await get(started, `/api/reconciliations${query}`, owner)).json()).reconciliations as unknown[]).length;
    expect([await listed("?kassa=tashkent"), await listed("?kassa=andijan"), await listed("")]).toEqual([1, 0, 1]);
  });

  it("tells each desk's topic of the group everything of that desk, the main desk by kind, a desk without a topic in the main one", async () => {
    telegram = await startFakeTelegram();
    const { started, timur, ali, mudir, sardor } = await desk({
      telegramBotToken: "123456:SECRET-TOKEN",
      telegramGroupChatId: "-1001234567890",
      telegramIncomeThreadId: 3,
      telegramExpenseThreadId: 5,
      telegramKassaThreadIds: { tashkent: 9 },
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
    });
    const spent = dollars({ amountMinor: 3_000 });
    await post(started, timur, spent);
    await post(started, ali, payment({ clientCode: "А1" }));
    await post(started, mudir, payment({ clientCode: "А2" }));
    await post(started, mudir, dollars({ amountMinor: 700 }));
    expect((await deleteRequest(started, `/api/operations/${spent.id}`, timur)).status).toBe(200);
    await postJson(started, "/api/reconciliations", { id: randomUUID(), counted: [{ currency: "USD", amountMinor: 4_000 }] }, sardor);

    const messages = await telegram.untilMessages(6);
    expect(messages).toHaveLength(6);
    const tashkent = messages.filter((message) => message.threadId === 9).map((message) => message.text);
    expect(tashkent).toHaveLength(3);
    // A count of a desk of dollars says the dollars only.
    expect(tashkent[2]).toBe("Кассада колган пул\n40$. Доллар");
    expect(messages.filter((message) => message.threadId === 3).map((message) => message.text)).toEqual([expect.stringContaining("А2")]);
    expect(messages.filter((message) => message.threadId === 5)).toHaveLength(1);
    expect(messages.filter((message) => message.threadId === undefined).map((message) => message.text)).toEqual([expect.stringContaining("А1")]);
    // The desks keep the same money: where the topic does not say whose a message is, its last line does.
    expect(tashkent.filter((text) => text.includes("Касса:"))).toEqual([]);
    expect(messages.filter((message) => message.threadId !== 9).map((message) => message.text.split("\n").at(-1)).sort()).toEqual(["Касса: Андижан", "Касса: Москва", "Касса: Москва"]);
  });

  it("says in every message which desk it is about when the three desks share one chat", async () => {
    telegram = await startFakeTelegram();
    const { started, timur, sardor } = await desk({
      telegramBotToken: "123456:SECRET-TOKEN",
      telegramGroupChatId: "-1001234567890",
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
    });
    await post(started, timur, payment({ clientCode: "А7" }));
    await postJson(started, "/api/reconciliations", { id: randomUUID(), counted: [{ currency: "USD", amountMinor: 30_000 }] }, sardor);

    const messages = await telegram.untilMessages(2);
    expect(messages.map((message) => message.threadId)).toEqual([undefined, undefined]);
    expect(messages[0]!.text).toMatch(/^💰 Приход от клиента А7\n300,00\s\$\nПринял: Тимур, .* МСК\nКасса: Ташкент$/);
    expect(messages[1]!.text).toBe("Кассада колган пул\n300$. Доллар\nКасса: Ташкент");
  });

  it("writes to 1C the payments of the desks the settings name, each into its cash desk of the base", async () => {
    onec = await startFakeOneC();
    const tashkentKassa = "7a1e52c0-924a-11f1-8cb7-b8cb29f61f4c";
    onec.addClient("А406", "Жавид");
    const { started, timur, ali, mudir } = await desk({
      onec: {
        url: onec.url,
        user: onec.user,
        password: onec.password,
        organizationKey: KEYS.organization,
        kassaKey: KEYS.kassa,
        kassaKeys: { tashkent: tashkentKassa },
        currencyKey: KEYS.currency,
        mode: "live",
      },
      onecKassas: ["moscow", "tashkent"],
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
    });
    expect((await (await get(started, "/api/kassas", ali)).json()).kassas.map((item: { id: string; onec: boolean }) => [item.id, item.onec])).toEqual([
      ["moscow", true],
      ["andijan", false],
      ["tashkent", true],
    ]);

    expect((await post(started, mudir, payment({ amountMinor: 10_000 }))).status).toBe(201);
    expect((await post(started, timur, payment({ amountMinor: 20_000 }))).status).toBe(201);
    expect((await post(started, ali, payment({ amountMinor: 30_000 }))).status).toBe(201);

    const written = async () => started.query<{ status: string; kassa: string }>("SELECT q.status, o.kassa FROM onec_outbox q JOIN operations o ON o.id = q.operation_id ORDER BY q.id");
    await expect.poll(async () => (await written()).filter((row) => row.status === "written").length, { timeout: 10_000 }).toBe(2);
    // The payment of Andijan was never queued: its desk keeps no book in 1C.
    expect((await written()).map((row) => row.kassa).sort()).toEqual(["moscow", "tashkent"]);
    expect(onec.documents.map((document) => [document["СуммаДокумента"], document["КассаОрганизации_Key"]]).sort()).toEqual([
      [100, KEYS.kassa],
      [200, tashkentKassa],
    ]);
  });
});

describe("a desk that the settings stop writing to 1C", () => {
  let app: TestApp | undefined;
  let onec: FakeOneC | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await onec?.close();
    onec = undefined;
  });

  it("gets nothing more written, and its document is not moved to the cash desk of another desk", async () => {
    const fake = await startFakeOneC();
    onec = fake;
    const tashkentKassa = "7a1e52c0-924a-11f1-8cb7-b8cb29f61f4c";
    fake.addClient("А406", "Жавид");
    const kassas = parseKassas(THREE_DESKS);
    const base = { url: fake.url, user: fake.user, password: fake.password, organizationKey: KEYS.organization, kassaKey: KEYS.kassa, currencyKey: KEYS.currency, mode: "live" as const };
    const onecQueue = { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 };
    const started = await startTestApp({ kassas, onec: { ...base, kassaKeys: { tashkent: tashkentKassa } }, onecKassas: ["moscow", "tashkent"], onecQueue });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const payment = (amountMinor: number) => ({ id: randomUUID(), type: "income", amountMinor, currency: "USD", category: "client_payment", clientCode: "А406 Жавид", kassa: "tashkent" });
    type Queued = { operation_id: string; status: string; detail: string | null };
    const queued = (from: TestApp) => from.query<Queued>("SELECT operation_id, status, detail FROM onec_outbox ORDER BY id");

    const written = payment(20_000);
    expect((await postJson(started, "/api/operations", written, mudir)).status).toBe(201);
    await expect.poll(async () => (await queued(started)).map((row) => row.status), { timeout: 10_000 }).toEqual(["written"]);
    expect(fake.documents.map((document) => [document["СуммаДокумента"], document["КассаОрганизации_Key"], document.Posted])).toEqual([[200, tashkentKassa, true]]);

    // The settings change: only Moscow goes to 1C now, and Tashkent has no cash desk of its own there any more.
    await started.whileStopped(async () => {
      const changed = await startTestApp({ databaseUrl: started.databaseUrl, kassas, onec: base, onecKassas: ["moscow"], onecQueue });
      try {
        // A payment of Tashkent that was queued before the change and is still waiting.
        const waiting = payment(30_000);
        expect((await postJson(changed, "/api/operations", waiting, mudir)).status).toBe(201);
        expect((await queued(changed)).map((row) => row.operation_id)).toEqual([written.id]);
        await changed.execute("INSERT INTO onec_outbox (operation_id, created_at, next_attempt_at) VALUES ($1, now(), now())", [waiting.id]);
        // And a correction of the payment that is in 1C already.
        expect((await putJson(changed, `/api/operations/${written.id}`, { ...written, id: undefined, kassa: undefined, amountMinor: 25_000 }, mudir)).status).toBe(200);

        await expect.poll(async () => (await queued(changed)).map((row) => row.status), { timeout: 10_000 }).toEqual(["failed", "skipped"]);
        const rows = await queued(changed);
        expect(rows[0]!.detail).toMatch(/приходы кассы tashkent в 1С не записываются \(ONEC_KASSAS\), а документ №\S+ уже есть/);
        expect(rows[1]!.detail).toBe("приходы кассы tashkent в 1С не записываются (ONEC_KASSAS)");
        // The document stays what and where it was: not rewritten into the cash desk of Moscow, and no second one is made.
        expect(fake.documents.map((document) => [document["СуммаДокумента"], document["КассаОрганизации_Key"], document.Posted])).toEqual([[200, tashkentKassa, true]]);
      } finally {
        await changed.close();
      }
    });
  }, 60_000);
});

describe("the settings and what the database holds", () => {
  let app: TestApp | undefined;
  const pools: pg.Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await app?.close();
    app = undefined;
  });

  const poolOf = (started: TestApp) => {
    const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 1 });
    pools.push(pool);
    return pool;
  };

  /** Starts the real server (src/main.ts) the way the service does, and waits for it to end: only for a start that is refused. */
  function startServer(env: Record<string, string | undefined>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        // The port is never listened on: the server is refused before that.
        env: { ...process.env, KASSAS: undefined, PORT: "65431", ...env },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stderr: `${stderr}\n(the server went on running: it was not refused)` });
      }, 25_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
  }

  it("must agree about the desks: a desk that has entries, a count or an opening balance is still in the settings", async () => {
    const three = parseKassas(THREE_DESKS);
    const started = await startTestApp({ kassas: three });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "sardor", password: "tashkent counter", role: "head_cashier", displayName: "Сардор" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const sardor = await loginAs(started, "sardor", "tashkent counter");
    const pool = poolOf(started);
    const nothing = { desks: [], money: [] };
    // An empty book agrees with any settings.
    expect(await outsideSettings(pool, parseKassas("fergana=Фергана:USD"))).toEqual(nothing);

    // An opening balance of nothing is no money: it holds no desk in the settings.
    await started.admin.setOpeningBalance("USD", "0", "andijan");
    expect(await outsideSettings(pool, parseKassas("moscow:USD"))).toEqual(nothing);
    // An opening balance, an entry, a count: each is something of its desk.
    await started.admin.setOpeningBalance("USD", "10", "andijan");
    expect(await outsideSettings(pool, parseKassas("moscow:USD"))).toEqual({ desks: ["andijan"], money: [] });
    expect((await postJson(started, "/api/reconciliations", { id: randomUUID(), kassa: "tashkent", counted: [{ currency: "USD", amountMinor: 0 }] }, sardor)).status).toBe(201);
    expect(await outsideSettings(pool, parseKassas("moscow:USD,andijan:USD"))).toEqual({ desks: ["tashkent"], money: [] });
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 100, currency: "USD", category: "fuel_road" }, mudir)).status).toBe(201);
    expect(await outsideSettings(pool, parseKassas("andijan:USD,tashkent:USD"))).toEqual({ desks: ["moscow"], money: [] });

    expect(await outsideSettings(pool, three)).toEqual(nothing);
    await expect(assertKassasCoverDatabase(started.databaseUrl, three)).resolves.toBeUndefined();
    await expect(assertKassasCoverDatabase(started.databaseUrl, parseKassas("moscow:USD,taskent=Ташкент:USD"))).rejects.toThrow(
      /The cash desks of the settings \(KASSAS\) are moscow:USD,taskent:USD, and the database has entries of andijan, tashkent too/,
    );
  });

  it("must agree about the money: a desk that has rubles is not said to keep dollars only", async () => {
    // The book of the first company: rubles and dollars in Moscow, dollars in Andijan.
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const pool = poolOf(started);
    await started.admin.setOpeningBalance("USD", "50");
    expect((await postJson(started, "/api/operations", withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17" }), mudir)).status).toBe(201);
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 100, currency: "USD", category: "fuel_road", kassa: "andijan" }, mudir)).status).toBe(201);

    expect(await outsideSettings(pool, parseKassas(undefined))).toEqual({ desks: [], money: [] });
    // The line of the other company's file in this one's: the rubles of Moscow would drop out of every balance.
    expect(await outsideSettings(pool, parseKassas(THREE_DESKS))).toEqual({ desks: [], money: ["moscow in RUB"] });
    await expect(assertKassasCoverDatabase(started.databaseUrl, parseKassas(THREE_DESKS))).rejects.toThrow(
      /are moscow:USD,andijan:USD,tashkent:USD, and the database has money of moscow in RUB\. .* with every currency it has them in/,
    );
    // Giving a desk more money to keep, or the business more desks, takes nothing out.
    expect(await outsideSettings(pool, parseKassas("moscow:RUB+USD,andijan:RUB+USD,tashkent:USD"))).toEqual({ desks: [], money: [] });
  });

  it("are checked when the real server starts: it does not start on a book the settings leave money out of", async () => {
    const started = await startTestApp({ kassas: parseKassas(THREE_DESKS) });
    app = started;
    await started.admin.setOpeningBalance("USD", "70", "tashkent");
    const settings = { DATABASE_URL: started.databaseUrl };

    const refused = await startServer({ ...settings, KASSAS: "moscow:USD,andijan:USD" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the database has entries of tashkent too");
    // Without the line at all the desks are Moscow and Andijan, and Tashkent's money is left out just the same.
    const forgotten = await startServer(settings);
    expect(forgotten.code).toBe(1);
    expect(forgotten.stderr).toContain("the database has entries of tashkent too");
    // A line that cannot be read is refused before the database is asked anything.
    const unreadable = await startServer({ ...settings, KASSAS: "moscow:USD;tashkent:USD" });
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("KASSAS has a part that is not id:CURRENCY");
  }, 120_000);
});

describe("an installation that names no desks", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("has the two desks it always had, Moscow first, and no other city", async () => {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");

    expect(await (await get(started, "/api/kassas", mudir)).json()).toEqual({
      kassas: [
        { id: "moscow", label: "Москва", short: "МСК", currencies: ["RUB", "USD"], onec: true },
        { id: "andijan", label: "Андижан", short: "АНД", currencies: ["USD"], onec: false },
      ],
    });
    expect(await (await get(started, "/api/operations/defaults", mudir)).json()).toEqual({ currency: "RUB" });
    const me = (await (await get(started, "/api/admin/users", mudir)).json()).users[0] as { id: string };
    expect((await patchJson(started, `/api/admin/users/${me.id}`, { city: "tashkent" }, mudir)).status).toBe(400);
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 100, currency: "USD", category: "fuel_road", kassa: "tashkent" }, mudir)).status).toBe(400);
  });
});

describe("the database of before the desks came from the settings", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("keeps everything it stored, and from then on takes a desk of any name the settings may have", async () => {
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    const pool = new pg.Pool({ connectionString: database.url, max: 2 });
    cleanups.unshift(() => pool.end());

    // The database as the version with the two fixed desks left it: every migration before this one.
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const before = files.filter((name) => name < "0023");
    await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of before) {
      await pool.query(await readFile(new URL(name, directory), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    }
    expect(before.at(-1)).toBe("0022_onec_removed.sql");

    const user = (await pool.query<{ id: string }>("INSERT INTO users (login, display_name, password_hash, role, city) VALUES ('ali', 'Али', 'x', 'head_cashier', 'andijan') RETURNING id")).rows[0]!.id;
    const insert = (id: string, kassa: string, currency: string) =>
      pool.query(
        `INSERT INTO operations (id, kind, amount_minor, currency, category, author_id, created_at, kassa)
         VALUES ($1, 'expense', 500, $2, 'fuel_road', $3, '2026-03-05T10:00:00Z', $4)`,
        [id, currency, user, kassa],
      );
    const [moscow, andijan] = [randomUUID(), randomUUID()];
    await insert(moscow, "moscow", "RUB");
    await insert(andijan, "andijan", "USD");
    await pool.query("INSERT INTO opening_balances (kassa, currency, amount_minor) VALUES ('moscow', 'RUB', 100000), ('andijan', 'USD', 5000)");
    await pool.query("INSERT INTO reconciliations (id, kassa, made_by, made_at) VALUES ($1, 'andijan', $2, '2026-03-05T15:00:00Z')", [randomUUID(), user]);
    await pool.query("UPDATE categories SET city = 'andijan' WHERE code = 'fuel_road'");
    // What the earlier version refused: a desk it did not know, and rubles in Andijan.
    await expect(insert(randomUUID(), "tashkent", "USD")).rejects.toThrow(/operations_kassa_check/);
    await expect(insert(randomUUID(), "andijan", "RUB")).rejects.toThrow(/operations_andijan_dollars/);
    const stored = () =>
      pool.query(
        `SELECT (SELECT json_agg(json_build_array(id, kassa, currency) ORDER BY kassa) FROM operations) AS operations,
                (SELECT json_agg(json_build_array(kassa, currency, amount_minor) ORDER BY kassa) FROM opening_balances) AS opening,
                (SELECT json_agg(kassa) FROM reconciliations) AS counts,
                (SELECT city FROM users WHERE login = 'ali') AS user_city,
                (SELECT city FROM categories WHERE code = 'fuel_road') AS category_city`,
      );
    const was = (await stored()).rows[0];

    expect(await migrate(pool)).toEqual(["0023_kassas_from_settings.sql"]);

    expect((await stored()).rows[0]).toEqual(was);
    expect(was.operations).toEqual([[andijan, "andijan", "USD"], [moscow, "moscow", "RUB"]]);
    // The names of the desks are the settings' to say now, and so is the money each keeps (rubles in Andijan are the
    // server's to refuse, not the database's); the database keeps to the shape of an id, in every table that has one.
    await insert(randomUUID(), "tashkent", "USD");
    await insert(randomUUID(), "andijan", "RUB");
    await pool.query("INSERT INTO opening_balances (kassa, currency, amount_minor) VALUES ('tashkent', 'USD', 7000)");
    await pool.query("INSERT INTO reconciliations (id, kassa, made_by, made_at) VALUES ($1, 'tashkent', $2, '2026-03-06T15:00:00Z')", [randomUUID(), user]);
    await pool.query("UPDATE users SET city = 'tashkent' WHERE id = $1", [user]);
    await pool.query("UPDATE categories SET city = 'tashkent' WHERE code = 'fuel_road'");
    await pool.query("UPDATE categories SET city = NULL WHERE code = 'fuel_road'");
    await expect(insert(randomUUID(), "Tashkent City", "USD")).rejects.toThrow(/operations_kassa_check/);
    await expect(pool.query("INSERT INTO opening_balances (kassa, currency, amount_minor) VALUES ('Tashkent', 'USD', 1)")).rejects.toThrow(/opening_balances_kassa_check/);
    await expect(pool.query("INSERT INTO reconciliations (id, kassa, made_by, made_at) VALUES ($1, 'no desk', $2, now())", [randomUUID(), user])).rejects.toThrow(/reconciliations_kassa_check/);
    await expect(pool.query("UPDATE users SET city = '' WHERE id = $1", [user])).rejects.toThrow(/users_city_check/);
    await expect(pool.query("UPDATE categories SET city = 'две кассы' WHERE code = 'fuel_road'")).rejects.toThrow(/categories_city_check/);
    // Nothing of the old lists is left behind under another name.
    const old = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''andijan''%'");
    expect(old.rows).toEqual([]);
    // The second time there is nothing to do.
    expect(await migrate(pool)).toEqual([]);
  }, 60_000);
});
