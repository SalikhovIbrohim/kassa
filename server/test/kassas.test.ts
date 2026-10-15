import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startFakeTelegram, type FakeTelegram } from "./helpers/fake-telegram.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

type Entry = Record<string, unknown>;

/**
 * Two cash desks in one book: Moscow (rubles and dollars) and Andijan (dollars only). The city a person has in «Люди»
 * is the desk they work in; a person of everywhere (the admin, the owner) sees both.
 */
describe("the cash desks of Moscow and Andijan", () => {
  let app: TestApp | undefined;
  let telegram: FakeTelegram | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await telegram?.close();
    telegram = undefined;
  });

  async function desk(options: Parameters<typeof startTestApp>[0] = {}) {
    const started = await startTestApp(options);
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "ali", password: "andijan cashier", role: "cashier", displayName: "Али" });
    await started.admin.createUser({ login: "bobur", password: "andijan counter", role: "head_cashier", displayName: "Бобур" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const users = (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ id: string; login: string }>;
    const setCity = async (login: string, city: string) =>
      expect((await patchJson(started, `/api/admin/users/${users.find((user) => user.login === login)!.id}`, { city }, mudir)).status).toBe(200);
    await setCity("ivan", "moscow");
    await setCity("ali", "andijan");
    await setCity("bobur", "andijan");
    await started.admin.setOpeningBalance("RUB", "1000");
    await started.admin.setOpeningBalance("USD", "50");
    return {
      started,
      mudir,
      ivan: await loginAs(started, "ivan", "correct horse"),
      ali: await loginAs(started, "ali", "andijan cashier"),
      bobur: await loginAs(started, "bobur", "andijan counter"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const dollars = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 2_000, currency: "USD", category: "fuel_road", ...overrides });
  const rubles = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  const post = (started: TestApp, cookie: string, body: Entry) => postJson(started, "/api/operations", body, cookie);
  const balances = async (started: TestApp, cookie: string, query = "") =>
    ((await (await get(started, `/api/balances${query}`, cookie)).json()) as { balances: Array<{ currency: string; amountMinor: number }> }).balances;

  it("books an entry in the desk of its cashier's city, and keeps the balances of the two desks apart", async () => {
    const { started, ivan, ali, mudir } = await desk();

    const spent = await post(started, ali, dollars());
    expect(spent.status).toBe(201);
    expect((await spent.json()).operation.kassa).toBe("andijan");
    expect((await post(started, ivan, rubles())).status).toBe(201);

    expect(await balances(started, ali)).toEqual([{ currency: "USD", amountMinor: -2_000 }]);
    expect(await balances(started, ivan)).toEqual([{ currency: "RUB", amountMinor: 150_000 }, { currency: "USD", amountMinor: 5_000 }]);
    // A person of everywhere chooses the desk; without saying, Moscow.
    expect(await balances(started, mudir, "?kassa=andijan")).toEqual([{ currency: "USD", amountMinor: -2_000 }]);
    expect(await balances(started, mudir)).toEqual(await balances(started, ivan));
  });

  it("does not let a cashier of one city into the other desk, and takes only dollars in Andijan", async () => {
    const { started, ivan, ali, mudir } = await desk();

    expect([(await post(started, ivan, dollars({ kassa: "andijan" }))).status]).toEqual([403]);
    expect((await get(started, "/api/balances?kassa=moscow", ali)).status).toBe(403);
    expect((await post(started, ali, rubles())).status).toBe(400);
    expect((await post(started, mudir, rubles({ kassa: "andijan" }))).status).toBe(400);
    expect((await post(started, mudir, dollars({ kassa: "andijan" }))).status).toBe(201);

    // A correction never turns an Andijan entry into rubles.
    const body = dollars();
    await post(started, ali, body);
    const corrected = await putJson(started, `/api/operations/${body.id}`, { ...body, id: undefined, kassa: undefined, currency: "RUB", rateE4: 790_000 }, ali);
    expect(corrected.status).toBe(400);
  });

  it("shows each cashier the journal of their desk, and a person of everywhere either or both", async () => {
    const { started, ivan, ali, owner } = await desk();
    const there = dollars();
    const here = rubles();
    await post(started, ali, there);
    await post(started, ivan, here);
    const ids = async (cookie: string, query = "") =>
      ((await (await get(started, `/api/operations${query}`, cookie)).json()).operations as Array<{ id: string }>).map((operation) => operation.id);

    expect(await ids(ali)).toEqual([there.id]);
    expect(await ids(ivan)).toEqual([here.id]);
    expect((await get(started, "/api/operations?kassa=moscow", ali)).status).toBe(403);
    expect(await ids(owner, "?kassa=andijan")).toEqual([there.id]);
    expect((await ids(owner)).sort()).toEqual([here.id, there.id].sort());
  });

  it("counts the totals of one desk, or of both with each currency on its own", async () => {
    const { started, ivan, ali, owner } = await desk();
    await post(started, ali, dollars({ type: "income", category: "client_payment", clientCode: "A1", amountMinor: 30_000 }));
    await post(started, ivan, rubles());
    const usd = async (query: string) =>
      ((await (await get(started, `/api/summary${query}`, owner)).json()).currencies as Array<{ currency: string; incomeMinor: number; closingMinor: number }>).find(
        (item) => item.currency === "USD",
      );
    expect(await usd("?kassa=andijan")).toMatchObject({ incomeMinor: 30_000, closingMinor: 30_000 });
    expect(await usd("?kassa=moscow")).toMatchObject({ incomeMinor: 0, closingMinor: 5_000 });
    expect(await usd("")).toMatchObject({ incomeMinor: 30_000, closingMinor: 35_000 });
    expect(((await (await get(started, "/api/summary?kassa=andijan", owner)).json()).currencies as unknown[]).length).toBe(1);
  });

  it("lets the head cashier of Andijan count his desk in dollars only, and the count moves only that desk", async () => {
    const { started, ivan, bobur, owner } = await desk();
    await post(started, ivan, rubles());
    const count = (body: Entry) => postJson(started, "/api/reconciliations", { id: randomUUID(), ...body }, bobur);

    expect((await count({ counted: [{ currency: "RUB", amountMinor: 0 }, { currency: "USD", amountMinor: 0 }] })).status).toBe(400);
    expect((await count({ counted: [{ currency: "USD", amountMinor: 700 }], cardMinor: 100 })).status).toBe(400);
    expect((await count({ kassa: "moscow", counted: [{ currency: "USD", amountMinor: 700 }] })).status).toBe(403);
    const made = await count({ counted: [{ currency: "USD", amountMinor: 700 }] });
    expect(made.status).toBe(201);
    const body = await made.json();
    expect(body.reconciliation).toMatchObject({ kassa: "andijan", currencies: [{ currency: "USD", calculatedMinor: 0, actualMinor: 700, differenceMinor: 700 }] });
    expect(body.balances).toEqual([{ currency: "USD", amountMinor: 700 }]);

    expect(await balances(started, ivan)).toEqual([{ currency: "RUB", amountMinor: 150_000 }, { currency: "USD", amountMinor: 5_000 }]);
    const listed = async (query: string) => ((await (await get(started, `/api/reconciliations${query}`, owner)).json()).reconciliations as unknown[]).length;
    expect(await listed("?kassa=andijan")).toBe(1);
    expect(await listed("?kassa=moscow")).toBe(0);
  });

  it("tells the topic of Andijan everything of its desk: entries, corrections, counts", async () => {
    telegram = await startFakeTelegram();
    const { started, ali, ivan, bobur } = await desk({
      telegramBotToken: "123456:SECRET-TOKEN",
      telegramGroupChatId: "-1001234567890",
      telegramIncomeThreadId: 3,
      telegramExpenseThreadId: 5,
      telegramAndijanThreadId: 7,
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
    });
    const body = dollars({ amountMinor: 3_000 });
    await post(started, ali, body);
    await post(started, ivan, rubles({ category: "client_payment" }));
    expect((await deleteRequest(started, `/api/operations/${body.id}`, ali)).status).toBe(200);
    await postJson(started, "/api/reconciliations", { id: randomUUID(), counted: [{ currency: "USD", amountMinor: 4_000 }] }, bobur);

    const messages = await telegram.untilMessages(4);
    const andijan = messages.filter((message) => message.threadId === 7);
    expect(andijan).toHaveLength(3);
    expect(andijan[2]!.text).toBe("Кассада колган пул\n40$. Доллар");
    expect(messages.filter((message) => message.threadId === 3)).toHaveLength(1);
  });
});
