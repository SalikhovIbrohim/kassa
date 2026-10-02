import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seenChats } from "../src/telegram-api.js";
import { deleteRequest, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startFakeTelegram, type FakeTelegram } from "./helpers/fake-telegram.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const TOKEN = "123456:SECRET-TOKEN";
const GROUP = "-1001234567890";

type Entry = Record<string, unknown>;

/** The Telegram group is told about the incomes of clients: entered, corrected, deleted. */
describe("messages for the Telegram group", () => {
  let app: TestApp | undefined;
  let telegram: FakeTelegram;

  beforeEach(async () => {
    telegram = await startFakeTelegram();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await telegram.close();
  });

  async function desk(options: { group?: boolean; incomeThread?: number; expenseThread?: number } = {}) {
    const started = await startTestApp({
      telegramBotToken: TOKEN,
      telegramGroupChatId: options.group === false ? undefined : GROUP,
      telegramIncomeThreadId: options.incomeThread,
      telegramExpenseThreadId: options.expenseThread,
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
    });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Мухаммад Али" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const payment = (overrides: Entry = {}): Entry => ({
    id: randomUUID(),
    type: "income",
    amountMinor: 118_500,
    currency: "RUB",
    rateE4: 790_000,
    category: "client_payment",
    clientCode: "A406 Жавид",
    ...overrides,
  });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });

  const post = async (started: TestApp, cookie: string, body: Entry) => (await postJson(started, "/api/operations", body, cookie)).status;
  /** Gives the worker time to send what it would send, for the checks that nothing was sent. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("tells the group of an income of a client: who, how much, at which rate and what it is in dollars, who took it", async () => {
    const { started, ivan } = await desk();

    expect(await post(started, ivan, payment({ comment: "за рейс P194" }))).toBe(201);

    const [message] = await telegram.untilMessages(1);
    expect(message).toMatchObject({ token: TOKEN, chatId: GROUP });
    expect(message!.text).toContain("Приход от клиента A406 Жавид");
    expect(message!.text).toMatch(/1\s185,00\s₽ · курс 79,00 · ≈ 15,00\s\$/);
    expect(message!.text).toContain("Принял: Мухаммад Али");
    expect(message!.text).toContain("Комментарий: за рейс P194");
  });

  it("writes the incomes into one topic of a group that has topics and the expenses into another, and into the main one when it is not told", async () => {
    const { started, ivan } = await desk({ incomeThread: 3, expenseThread: 5 });
    await post(started, ivan, payment());
    await post(started, ivan, expense());
    const messages = await telegram.untilMessages(2);
    expect(messages.map((message) => message.threadId)).toEqual([3, 5]);
    await app?.close();
    app = undefined;

    const plain = await desk();
    await post(plain.started, plain.ivan, payment());
    const all = await telegram.untilMessages(3);
    expect(all[2]!.threadId).toBeUndefined();
  });

  it("says dollars as they are", async () => {
    const { started, ivan } = await desk();

    await post(started, ivan, payment({ currency: "USD", rateE4: undefined, amountMinor: 70_000 }));

    const [message] = await telegram.untilMessages(1);
    expect(message!.text).toMatch(/700,00\s\$/);
    expect(message!.text).not.toContain("курс");
  });

  it("tells of an expense: what it was for, to whom, how much, who gave it out", async () => {
    const { started, ivan } = await desk();

    await post(started, ivan, expense({ category: "freight_payment", amountMinor: 4_910_000, recipient: "Азамат", comment: "P194", rateE4: 790_000 }));

    const [message] = await telegram.untilMessages(1);
    expect(message!.text).toContain("💸 Расход «Оплата фура»");
    expect(message!.text).toMatch(/49\s100,00\s₽ · курс 79,00/);
    expect(message!.text).toContain("Кому: Азамат");
    expect(message!.text).toContain("Комментарий: P194");
    expect(message!.text).toContain("Выдал: Мухаммад Али");
  });

  it("tells of the correction and the deletion of an expense, and of the category that was changed", async () => {
    const { started, ivan } = await desk();
    const body = expense({ category: "fuel_road", amountMinor: 10_000 });
    await post(started, ivan, body);
    await telegram.untilMessages(1);

    await putJson(started, `/api/operations/${body.id}`, { type: "expense", amountMinor: 12_000, currency: "RUB", category: "customs", reason: "не та статья" }, ivan);
    await deleteRequest(started, `/api/operations/${body.id}`, ivan);

    const [, edited, deleted] = await telegram.untilMessages(3);
    expect(edited!.text).toContain("Исправлено: Расход «Топливо и дорога»");
    expect(edited!.text).toMatch(/Было: 100,00\s₽/);
    expect(edited!.text).toMatch(/Стало: 120,00\s₽/);
    expect(edited!.text).toContain("Категория: было «Топливо и дорога», стало «Таможня»");
    expect(deleted!.text).toContain("Удалено: Расход «Таможня»");
  });

  it("is silent about the incomes that are not payments of clients, until the owner ticks the category", async () => {
    const { started, ivan, owner } = await desk();

    await post(started, ivan, payment({ category: "debt_taken", clientCode: undefined }));
    await settle();
    expect(telegram.messages).toEqual([]);

    const ticked = await patchJson(started, "/api/admin/categories/debt_taken", { notifyGroup: true }, owner);
    expect(ticked.status).toBe(200);
    expect((await ticked.json()).category).toMatchObject({ notifyGroup: true });
    await post(started, ivan, payment({ category: "debt_taken", clientCode: undefined }));

    const [message] = await telegram.untilMessages(1);
    expect(message!.text).toContain("Приход «Взяли долг»");
  });

  it("is silent about a category that the owner has unticked", async () => {
    const { started, ivan, owner } = await desk();
    await patchJson(started, "/api/admin/categories/fuel_road", { notifyGroup: false }, owner);

    await post(started, ivan, expense({ category: "fuel_road" }));
    await post(started, ivan, expense({ category: "customs" }));

    const [message] = await telegram.untilMessages(1);
    await settle();
    expect(telegram.messages).toHaveLength(1);
    expect(message!.text).toContain("«Таможня»");
  });

  it("says that an entry is not told of any more when its category was changed to one that is not", async () => {
    const { started, ivan, owner } = await desk();
    await patchJson(started, "/api/admin/categories/other", { notifyGroup: false }, owner);
    const body = expense({ category: "fuel_road" });
    await post(started, ivan, body);
    await telegram.untilMessages(1);

    await putJson(started, `/api/operations/${body.id}`, { type: "expense", amountMinor: 10_000, currency: "RUB", category: "other" }, ivan);

    const [, message] = await telegram.untilMessages(2);
    expect(message!.text).toContain("теперь «Прочее», о ней группе не сообщаем");
  });

  it("tells it once, however often the entry is sent", async () => {
    const { started, ivan } = await desk();
    const body = payment();

    await post(started, ivan, body);
    await post(started, ivan, body);
    await telegram.untilMessages(1);
    await settle();

    expect(telegram.messages).toHaveLength(1);
  });

  it("tells of a correction, with what it was and what it became, and who made it and why", async () => {
    const { started, ivan } = await desk();
    const body = payment();
    await post(started, ivan, body);
    await telegram.untilMessages(1);

    const edit = await putJson(
      started,
      `/api/operations/${body.id}`,
      { type: "income", amountMinor: 120_000, currency: "RUB", rateE4: 800_000, category: "client_payment", clientCode: "A406 Жавид", reason: "ошибся в сумме" },
      ivan,
    );

    expect(edit.status).toBe(200);
    const [, message] = await telegram.untilMessages(2);
    expect(message!.text).toContain("Исправлено: Приход от клиента A406 Жавид");
    expect(message!.text).toMatch(/Было: 1\s185,00\s₽ · курс 79,00/);
    expect(message!.text).toMatch(/Стало: 1\s200,00\s₽ · курс 80,00 · ≈ 15,00\s\$/);
    expect(message!.text).toContain("Исправил: Мухаммад Али");
    expect(message!.text).toContain("причина: ошибся в сумме");
  });

  it("says nothing of a correction that changes nothing", async () => {
    const { started, ivan } = await desk();
    const body = payment();
    await post(started, ivan, body);
    await telegram.untilMessages(1);

    await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 118_500, currency: "RUB", rateE4: 790_000, category: "client_payment", clientCode: "A406 Жавид" }, ivan);
    await settle();

    expect(telegram.messages).toHaveLength(1);
  });

  it("tells of a deletion", async () => {
    const { started, ivan } = await desk();
    const body = payment();
    await post(started, ivan, body);
    await telegram.untilMessages(1);

    await deleteRequest(started, `/api/operations/${body.id}`, ivan, { reason: "дубль" });

    const [, message] = await telegram.untilMessages(2);
    expect(message!.text).toContain("Удалено: Приход от клиента A406 Жавид");
    expect(message!.text).toMatch(/Было: 1\s185,00\s₽/);
    expect(message!.text).toContain("Удалил: Мухаммад Али");
    expect(message!.text).toContain("причина: дубль");
  });

  it("tells when an income stops being a payment of a client, and when another income becomes one", async () => {
    const { started, ivan } = await desk();
    const first = payment();
    await post(started, ivan, first);
    const other = payment({ category: "debt_taken", clientCode: undefined });
    await post(started, ivan, other);
    await telegram.untilMessages(1);

    await putJson(started, `/api/operations/${first.id}`, { type: "income", amountMinor: 118_500, currency: "RUB", rateE4: 790_000, category: "debt_taken" }, ivan);
    await putJson(started, `/api/operations/${other.id}`, { type: "income", amountMinor: 118_500, currency: "RUB", rateE4: 790_000, category: "client_payment", clientCode: "B7" }, ivan);

    const messages = await telegram.untilMessages(3);
    expect(messages[1]!.text).toContain("теперь «Взяли долг», о ней группе не сообщаем");
    expect(messages[2]!.text).toContain("Приход от клиента B7");
    expect(messages[2]!.text).toContain("внесено исправлением записи");
  });

  it("keeps the entry and sends the message later when Telegram cannot be reached", async () => {
    const { started, ivan } = await desk();
    telegram.failNext(500, 2);

    expect(await post(started, ivan, payment())).toBe(201);

    const messages = await telegram.untilMessages(1);
    expect(messages).toHaveLength(1);
    expect(telegram.requests).toBeGreaterThanOrEqual(3);
    await settle();
    expect(telegram.messages).toHaveLength(1);
  });

  it("keeps the order: a message that has to wait holds back the ones after it", async () => {
    const { started, ivan } = await desk();
    telegram.failNext(500, 3);

    await post(started, ivan, payment({ clientCode: "ПЕРВЫЙ" }));
    await post(started, ivan, payment({ clientCode: "ВТОРОЙ" }));

    const messages = await telegram.untilMessages(2);
    expect(messages[0]!.text).toContain("ПЕРВЫЙ");
    expect(messages[1]!.text).toContain("ВТОРОЙ");
  });

  it("gives up a message that Telegram will never take, goes on with the next, and never writes the token down", async () => {
    const { started, ivan } = await desk();
    telegram.failNext(403);

    await post(started, ivan, payment({ clientCode: "НЕ УЙДЁТ" }));
    await post(started, ivan, payment({ clientCode: "УЙДЁТ" }));

    const messages = await telegram.untilMessages(1);
    expect(messages[0]!.text).toContain("УЙДЁТ");
    const rows = await started.query<{ status: string; last_error: string | null; text: string }>("SELECT status, last_error, text FROM telegram_outbox ORDER BY id");
    expect(rows.map((row) => row.status)).toEqual(["failed", "sent"]);
    expect(rows[0]!.last_error).toContain("403");
    expect(JSON.stringify(rows)).not.toContain("SECRET-TOKEN");
  });

  it("waits as long as Telegram asks when it says to slow down", async () => {
    const { started, ivan } = await desk();
    telegram.failNext(429, 1, 1);
    const startedAt = Date.now();

    await post(started, ivan, payment());

    await telegram.untilMessages(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it("writes nothing when no group is set up, and the operations go on as before", async () => {
    const { started, ivan } = await desk({ group: false });

    expect(await post(started, ivan, payment())).toBe(201);
    await settle();

    expect(await started.query("SELECT 1 FROM telegram_outbox")).toEqual([]);
    expect(telegram.requests).toBe(0);
  });
});

describe("finding the group", () => {
  it("lists the chats the bot has been told about, once each, with a name", async () => {
    const telegram = await startFakeTelegram();
    telegram.setUpdates([
      { update_id: 1, my_chat_member: { chat: { id: -1001234567890, title: "Касса Москва", type: "supergroup" } } },
      { update_id: 2, message: { chat: { id: -1001234567890, title: "Касса Москва", type: "supergroup" }, text: "/start" } },
      { update_id: 3, message: { chat: { id: 555, first_name: "Иван", type: "private" }, text: "привет" } },
    ]);

    const chats = await seenChats({ botToken: TOKEN, apiUrl: telegram.url });

    expect(chats).toEqual([
      { id: -1001234567890, type: "supergroup", title: "Касса Москва", topics: [] },
      { id: 555, type: "private", title: "Иван", topics: [] },
    ]);
    await telegram.close();
  });

  it("lists the topics of a group with topics that a message was seen in, with the name when it is known", async () => {
    const telegram = await startFakeTelegram();
    const chat = { id: -1001234567890, title: "Cosmo Kassa", type: "supergroup" };
    telegram.setUpdates([
      { update_id: 1, message: { chat, message_thread_id: 3, forum_topic_created: { name: "Приход" } } },
      { update_id: 2, message: { chat, message_thread_id: 3, text: "/start@excoskassabot" } },
      { update_id: 3, message: { chat, message_thread_id: 5, reply_to_message: { forum_topic_created: { name: "Расход" } }, text: "/start@excoskassabot" } },
      { update_id: 4, message: { chat, message_thread_id: 9, text: "/start@excoskassabot" } },
    ]);

    const [seen] = await seenChats({ botToken: TOKEN, apiUrl: telegram.url });

    expect(seen!.topics).toEqual([
      { id: 3, name: "Приход" },
      { id: 5, name: "Расход" },
      { id: 9, name: "" },
    ]);
    await telegram.close();
  });
});
