import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOneC } from "../src/admin/onec.js";
import { onecRetry, onecSkip, onecStatus } from "../src/admin/onec.js";
import { AdminError } from "../src/admin/users.js";
import type { OneCSettings } from "../src/onec-api.js";
import { deleteRequest, loginAs, postJson, putJson } from "./helpers/http.js";
import { startFakeOneC, KEYS, type FakeOneC } from "./helpers/fake-onec.js";
import { startFakeTelegram, type FakeTelegram } from "./helpers/fake-telegram.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const TOKEN = "123456:SECRET-TOKEN";
const GROUP = "-1001234567890";
const RECEIPTS = "/Document_ПриходныйКассовыйОрдер";

type Entry = Record<string, unknown>;
type Queued = { status: string; attempts: number; doc_ref: string | null; doc_number: string | null; detail: string | null; alerted: boolean };

/** The payments of clients are written into 1C as cash receipts: found by the client's code, never made up, never changed after. */
describe("writing the payments of clients to 1C", () => {
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

  async function desk(options: { mode?: "preview" | "live" | "off"; onlyClients?: string[]; logStream?: NodeJS.WritableStream; password?: string } = {}) {
    const mode = options.mode ?? "live";
    const started = await startTestApp({
      telegramBotToken: TOKEN,
      telegramGroupChatId: GROUP,
      telegramApiUrl: telegram.url,
      telegramQueue: { intervalMs: 40, baseBackoffSeconds: 0.05 },
      onec:
        mode === "off"
          ? undefined
          : {
              url: onec.url,
              user: onec.user,
              password: options.password ?? onec.password,
              organizationKey: KEYS.organization,
              kassaKey: KEYS.kassa,
              currencyKey: KEYS.currency,
              mode,
              onlyClients: options.onlyClients,
            },
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
      logStream: options.logStream,
    });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Мухаммад Али" });
    return { started, ivan: await loginAs(started, "ivan", "correct horse") };
  }

  const payment = (overrides: Entry = {}): Entry => ({
    id: randomUUID(),
    type: "income",
    amountMinor: 118_500,
    currency: "RUB",
    rateE4: 790_000,
    category: "client_payment",
    clientCode: "А406 Жавид",
    ...overrides,
  });
  const post = async (started: TestApp, cookie: string, body: Entry) => (await postJson(started, "/api/operations", body, cookie)).status;

  // The queue has no screen of its own yet except the admin command; the tests read its table, as the command does.
  const queued = (started: TestApp) =>
    started.query<Queued>("SELECT status, attempts, doc_ref, doc_number, detail, alerted FROM onec_outbox ORDER BY id");
  /** Waits until the queue holds `count` rows of this status. */
  async function until(started: TestApp, status: string, count = 1) {
    let rows: Queued[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      rows = await queued(started);
      if (rows.filter((row) => row.status === status).length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The queue never held ${count} of "${status}": ${JSON.stringify(rows)}`);
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const told = () => telegram.messages.filter((message) => message.text.includes("в 1С"));
  const writes = () => onec.requests.filter((line) => line.startsWith("POST"));

  it("writes the payment as one cash receipt, posted, for the client found by the code", async () => {
    const { counterpart, contract } = onec.addClient("А406", "Жавид");
    onec.addClient("А407", "Другой");
    const { started, ivan } = await desk();

    expect(await post(started, ivan, payment())).toBe(201);
    const [row] = await until(started, "written");

    expect(onec.documents).toHaveLength(1);
    const document = onec.documents[0]!;
    expect(document).toMatchObject({
      ВидОперации: "ОплатаПокупателя",
      Организация_Key: KEYS.organization,
      КассаОрганизации_Key: KEYS.kassa,
      ВалютаДокумента_Key: KEYS.currency,
      Контрагент: counterpart,
      ДоговорКонтрагента_Key: contract,
      // 1185.00 rubles at 79.00 is 15.00 dollars
      СуммаДокумента: 15,
      Комментарий: "А406",
      Posted: true,
    });
    expect(document.РасшифровкаПлатежа).toEqual([expect.objectContaining({ ДоговорКонтрагента_Key: contract, СуммаПлатежа: 15, СуммаВзаиморасчетов: 15 })]);
    expect(row).toMatchObject({ status: "written", doc_number: document.Number, doc_ref: document.Ref_Key });
    expect(row!.detail).toContain(String(document.Number));
  });

  it("writes dollars as they are", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk();

    await post(started, ivan, payment({ currency: "USD", rateE4: undefined, amountMinor: 70_000 }));
    await until(started, "written");

    expect(onec.documents[0]).toMatchObject({ СуммаДокумента: 700 });
  });

  it("dates the document with the moment of the entry in Moscow time", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk();
    const wanted = await post(started, ivan, payment());
    expect(wanted).toBe(201);
    await until(started, "written");

    const [created] = await started.query<{ created_at: Date }>("SELECT created_at FROM operations");
    const moscow = new Date(created!.created_at.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19);
    expect(onec.documents[0]!.Date).toBe(moscow);
  });

  it("writes one document however often the same entry comes", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk();
    const body = payment();

    expect(await post(started, ivan, body)).toBe(201);
    await post(started, ivan, body);
    await until(started, "written");
    await settle();

    expect(onec.documents).toHaveLength(1);
    expect(await queued(started)).toHaveLength(1);
  });

  it("only looks in the rehearsal mode: says what it would write, writes nothing", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk({ mode: "preview" });

    await post(started, ivan, payment());
    const [row] = await until(started, "preview");

    expect(row!.detail).toContain("репетиция");
    expect(row!.detail).toContain("А406 Жавид");
    expect(row!.detail).toMatch(/15,00\s\$/);
    expect(onec.documents).toEqual([]);
    expect(writes()).toEqual([]);
    expect(told()).toEqual([]);
  });

  it("does nothing when it is turned off", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk({ mode: "off" });

    expect(await post(started, ivan, payment())).toBe(201);
    await settle();

    expect(await queued(started)).toEqual([]);
    expect(onec.requests).toEqual([]);
  });

  it("leaves alone what is not a payment of a client", async () => {
    onec.addClient("А406", "Жавид");
    const { started, ivan } = await desk();

    await post(started, ivan, payment({ category: "debt_taken", clientCode: undefined }));
    await post(started, ivan, { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road" });
    await post(started, ivan, { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "client_refund", clientCode: "А406" });
    await settle();

    expect(await queued(started)).toEqual([]);
    expect(onec.requests).toEqual([]);
  });

  it("writes only the clients on the list when there is one, and says it is why it skipped the rest", async () => {
    onec.addClient("А406", "Жавид");
    onec.addClient("А500", "Другой");
    const { started, ivan } = await desk({ onlyClients: ["А500"] });

    await post(started, ivan, payment({ clientCode: "А406" }));
    await post(started, ivan, payment({ clientCode: "А500" }));
    const rows = await until(started, "written");
    await until(started, "skipped");

    expect(onec.documents).toHaveLength(1);
    expect(onec.documents[0]).toMatchObject({ Комментарий: "А500" });
    expect((await queued(started)).find((row) => row.status === "skipped")!.detail).toContain("COSMO_1C_CLIENTS");
    expect(rows).toHaveLength(2);
  });

  describe("a payment that cannot be placed waits for a person", () => {
    it("tells the group once that the client is not in 1C, and writes by itself when somebody adds the client", async () => {
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "blocked");
      expect(row!.detail).toContain("нет контрагента с кодом А406");
      for (let attempt = 0; attempt < 200 && told().length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(told()).toHaveLength(1);
      expect(told()[0]!.text).toContain("⚠️ Приход А406 Жавид");
      expect(told()[0]!.text).toContain("onec-skip");
      expect(onec.documents).toEqual([]);

      // Several tries go by while nobody does anything: still one message, and nothing written.
      await settle();
      expect(told()).toHaveLength(1);
      expect(writes()).toEqual([]);

      onec.addClient("А406", "Жавид");
      await until(started, "written");
      expect(onec.documents).toHaveLength(1);
      expect(told()).toHaveLength(1);
    });

    it("will not choose between two clients of one code", async () => {
      onec.addClient("А466", "Светлана");
      onec.addClient("А466", "Ольга");
      const { started, ivan } = await desk();

      await post(started, ivan, payment({ clientCode: "А466" }));
      const [row] = await until(started, "blocked");

      expect(row!.detail).toContain("несколько контрагентов");
      expect(onec.documents).toEqual([]);
    });

    it("takes the one the cashier named among two of one code", async () => {
      onec.addClient("А466", "Светлана");
      const { counterpart } = onec.addClient("А466", "Ольга");
      const { started, ivan } = await desk();

      await post(started, ivan, payment({ clientCode: "А466 Ольга" }));
      await until(started, "written");

      expect(onec.documents[0]).toMatchObject({ Контрагент: counterpart });
    });

    it("waits when the client has no contract, and never makes one", async () => {
      const { contract } = onec.addClient("А406", "Жавид");
      onec.contracts = onec.contracts.filter((row) => row.Ref_Key !== contract);
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "blocked");

      expect(row!.detail).toContain("нет договора");
      expect(writes()).toEqual([]);
    });

    it("waits when what is written in the code is no code of a client", async () => {
      onec.addClient("А406", "Жавид");
      const { started, ivan } = await desk();

      await post(started, ivan, payment({ clientCode: "Москва, рынок" }));
      const [row] = await until(started, "blocked");

      expect(row!.detail).toContain("нет кода вида А245");
      expect(onec.requests).toEqual([]);
    });

    it("is written with the corrected code when the cashier corrects the entry while it waits", async () => {
      const { counterpart } = onec.addClient("А406", "Жавид");
      const { started, ivan } = await desk();
      const body = payment({ clientCode: "Москва, рынок" });
      await post(started, ivan, body);
      await until(started, "blocked");

      const edit = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 118_500, currency: "RUB", rateE4: 790_000, category: "client_payment", clientCode: "А406", reason: "код" }, ivan);
      expect(edit.status).toBe(200);
      await until(started, "written");

      expect(onec.documents).toHaveLength(1);
      expect(onec.documents[0]).toMatchObject({ Контрагент: counterpart, Комментарий: "А406" });
    });

    it("is dropped when the cashier deletes the entry while it waits", async () => {
      const { started, ivan } = await desk();
      const body = payment();
      await post(started, ivan, body);
      await until(started, "blocked");

      expect((await deleteRequest(started, `/api/operations/${body.id}`, ivan, { reason: "дубль" })).status).toBe(200);
      const [row] = await until(started, "skipped");

      expect(row!.detail).toContain("удалён");
      onec.addClient("А406", "Жавид");
      await settle();
      expect(onec.documents).toEqual([]);
    });
  });

  describe("1C that does not answer", () => {
    it("tries again until it answers and writes one document", async () => {
      onec.addClient("А406", "Жавид");
      onec.failNext("POST /Document_ПриходныйКассовыйОрдер", 500, 2);
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "written");

      expect(row!.attempts).toBeGreaterThanOrEqual(3);
      expect(onec.documents).toHaveLength(1);
      expect(told()).toEqual([]);
    });

    it("tries again when the catalog could not be read", async () => {
      onec.addClient("А406", "Жавид");
      onec.failNext("GET /Catalog_Контрагенты", 503);
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      await until(started, "written");

      expect(onec.documents).toHaveLength(1);
    });

    it("adopts the document that a cut-off try made, instead of making a second one", async () => {
      onec.addClient("А406", "Жавид");
      onec.loseAnswerOf("POST /Document_ПриходныйКассовыйОрдер");
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "written");

      expect(onec.documents).toHaveLength(1);
      expect(onec.documents[0]).toMatchObject({ Posted: true });
      expect(row!.doc_number).toBe(onec.documents[0]!.Number);
    });

    it("goes on with the document it has when the posting was cut off", async () => {
      onec.addClient("А406", "Жавид");
      onec.loseAnswerOf("/Post");
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      await until(started, "written");

      expect(onec.documents).toHaveLength(1);
      expect(writes().filter((line) => line.startsWith(`POST ${RECEIPTS}(`))).not.toHaveLength(0);
      expect(writes().filter((line) => line === `POST ${RECEIPTS}`)).toHaveLength(1);
    });

    it("posts the document that was made but not posted, when the first try ended there", async () => {
      onec.addClient("А406", "Жавид");
      onec.failNext("/Post", 500);
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      await until(started, "written");

      expect(onec.documents).toHaveLength(1);
      expect(onec.documents[0]).toMatchObject({ Posted: true });
      expect(writes().filter((line) => line === `POST ${RECEIPTS}`)).toHaveLength(1);
    });
  });

  describe("1C that refuses", () => {
    it("gives up on a refusal, keeps the payment for a person and tells the group", async () => {
      onec.addClient("А406", "Жавид");
      onec.failNext("POST /Document_ПриходныйКассовыйОрдер", 400);
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "failed");

      expect(row!.detail).toContain("fake refusal 400");
      expect(onec.documents).toEqual([]);
      for (let attempt = 0; attempt < 200 && told().length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(told()).toHaveLength(1);
      expect(told()[0]!.text).toContain("❌ Приход А406 Жавид");
      expect(told()[0]!.text).toContain("onec-retry");
      await settle();
      expect(onec.documents).toEqual([]);
      expect(told()).toHaveLength(1);
    });

    it("gives up when the login is not accepted, and says nothing of the password", async () => {
      onec.addClient("А406", "Жавид");
      let log = "";
      const logStream = new Writable({
        write(chunk, _encoding, done) {
          log += String(chunk);
          done();
        },
      });
      const { started, ivan } = await desk({ password: "wrong-password", logStream });

      await post(started, ivan, payment());
      const [row] = await until(started, "failed");

      expect(row!.detail ?? "").not.toContain("wrong-password");
      expect(log).not.toContain("wrong-password");
      expect(log).not.toContain(onec.password);
      expect(log).not.toContain(onec.url);
      expect(onec.documents).toEqual([]);
    });

    it("does not call it written when the postings are not those of a payment, and leaves the document for a person", async () => {
      onec.addClient("А406", "Жавид");
      onec.postWrongly();
      const { started, ivan } = await desk();

      await post(started, ivan, payment());
      const [row] = await until(started, "failed");

      expect(row!.detail).toContain("проводка не такая");
      expect(row!.doc_number).toBe(onec.documents[0]!.Number);
      expect(onec.documents).toHaveLength(1);
      // Nothing is deleted or changed in 1C by the program.
      expect(onec.requests.filter((line) => line.startsWith("DELETE") || line.startsWith("PATCH") || line.startsWith("PUT"))).toEqual([]);
      for (let attempt = 0; attempt < 200 && told().length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(told()[0]!.text).toContain("❌");
    });
  });

  describe("what is done to the payment after it is in 1C", () => {
    async function written() {
      onec.addClient("А406", "Жавид");
      const { started, ivan } = await desk();
      const body = payment();
      await post(started, ivan, body);
      await until(started, "written");
      return { started, ivan, body };
    }

    it("is not done to the document: the group is told to correct it by hand when the entry is corrected", async () => {
      const { started, ivan, body } = await written();
      const before = JSON.stringify(onec.documents);
      const requests = onec.requests.length;

      const edit = await putJson(started, `/api/operations/${body.id}`, { type: "income", amountMinor: 120_000, currency: "RUB", rateE4: 790_000, category: "client_payment", clientCode: "А406 Жавид", reason: "опечатка" }, ivan);
      expect(edit.status).toBe(200);
      for (let attempt = 0; attempt < 200 && told().length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));

      expect(told()).toHaveLength(1);
      expect(told()[0]!.text).toContain("исправлен в Кассе");
      expect(told()[0]!.text).toContain(`ПКО №${onec.documents[0]!.Number}`);
      await settle();
      expect(JSON.stringify(onec.documents)).toBe(before);
      expect(onec.requests).toHaveLength(requests);
    });

    it("is not done to the document: the group is told to delete it by hand when the entry is deleted", async () => {
      const { started, ivan, body } = await written();
      const requests = onec.requests.length;

      expect((await deleteRequest(started, `/api/operations/${body.id}`, ivan, { reason: "ошибка" })).status).toBe(200);
      for (let attempt = 0; attempt < 200 && told().length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));

      expect(told()[0]!.text).toContain("удалён в Кассе");
      expect(told()[0]!.text).toContain("вручную");
      await settle();
      expect(onec.documents).toHaveLength(1);
      expect(onec.documents[0]).toMatchObject({ DeletionMark: false, Posted: true });
      expect(onec.requests).toHaveLength(requests);
      expect((await queued(started))[0]).toMatchObject({ status: "written" });
    });
  });
  describe("the commands of the administrator", () => {
    const settingsOf = (overrides: Partial<OneCSettings> = {}): OneCSettings => ({
      url: onec.url,
      user: onec.user,
      password: onec.password,
      organizationKey: KEYS.organization,
      kassaKey: KEYS.kassa,
      currencyKey: KEYS.currency,
      mode: "live",
      ...overrides,
    });
    const pools: pg.Pool[] = [];
    afterEach(async () => {
      await Promise.all(pools.splice(0).map((pool) => pool.end()));
    });
    const poolOf = (started: TestApp) => {
      const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 2 });
      pools.push(pool);
      return pool;
    };

    it("onec-check looks at 1C, says what the keys are, and changes nothing", async () => {
      const lines: string[] = [];

      const good = await checkOneC(settingsOf({ onlyClients: ["А339"] }), (line) => lines.push(line));

      expect(good).toBe(true);
      const text = lines.join("\n");
      expect(text).toContain("«Москва»");
      expect(text).toContain("«Доллар»");
      expect(text).toContain("БОЕВОЙ");
      expect(text).toContain("А339");
      expect(text).not.toContain("ПРОБЛЕМА");
      expect(onec.requests.every((line) => line.startsWith("GET"))).toBe(true);
      expect(text).not.toContain(onec.password);
      expect(text).not.toContain(onec.url);
    });

    it("onec-check says which key is wrong", async () => {
      const lines: string[] = [];

      const good = await checkOneC(settingsOf({ kassaKey: "00000000-0000-0000-0000-000000000000" }), (line) => lines.push(line));

      expect(good).toBe(false);
      expect(lines.filter((line) => line.includes("ПРОБЛЕМА"))).toEqual([expect.stringContaining("касса")]);
    });

    it("onec-check says that the login is not accepted, without the password", async () => {
      const lines: string[] = [];

      const good = await checkOneC(settingsOf({ password: "wrong-password" }), (line) => lines.push(line));

      expect(good).toBe(false);
      expect(lines.join("\n")).toContain("ПРОБЛЕМА");
      expect(lines.join("\n")).not.toContain("wrong-password");
    });

    it("onec-status lists the queue: the state, the payment, the document", async () => {
      onec.addClient("А406", "Жавид");
      const { started, ivan } = await desk();
      await post(started, ivan, payment());
      await post(started, ivan, payment({ clientCode: "А999" }));
      await until(started, "written");
      await until(started, "blocked");

      const lines = await onecStatus(poolOf(started), 20);

      expect(lines[0]).toContain("blocked 1");
      expect(lines[0]).toContain("written 1");
      expect(lines.join("\n")).toContain(`ПКО №${onec.documents[0]!.Number}`);
      expect(lines.join("\n")).toContain("А999");
      expect(await onecStatus(poolOf(started), 1)).toHaveLength(3);
    });

    it("onec-status says the queue is empty", async () => {
      const { started } = await desk();

      expect(await onecStatus(poolOf(started), 20)).toEqual([expect.stringContaining("пуста")]);
    });

    it("onec-retry puts a failed payment back, and it is written", async () => {
      onec.addClient("А406", "Жавид");
      onec.failNext("POST /Document_ПриходныйКассовыйОрдер", 400);
      const { started, ivan } = await desk();
      await post(started, ivan, payment());
      await until(started, "failed");
      const id = (await started.query<{ id: string }>("SELECT id::text FROM onec_outbox"))[0]!.id;

      await onecRetry(poolOf(started), id);
      await until(started, "written");

      expect(onec.documents).toHaveLength(1);
    });

    it("onec-retry goes on with the document that is already in 1C, and does not make a second", async () => {
      onec.addClient("А406", "Жавид");
      onec.postWrongly();
      const { started, ivan } = await desk();
      await post(started, ivan, payment());
      await until(started, "failed");
      const id = (await started.query<{ id: string }>("SELECT id::text FROM onec_outbox"))[0]!.id;

      // Somebody mended the postings in 1C by hand (here: the fake's entries are replaced), the payment is tried again.
      onec.fixPostings();
      const message = await onecRetry(poolOf(started), id);
      await until(started, "written");

      expect(message).toContain("no second one is made");
      expect(onec.documents).toHaveLength(1);
    });

    it("onec-retry and onec-skip refuse a payment that is written, and one that is not there", async () => {
      onec.addClient("А406", "Жавид");
      const { started, ivan } = await desk();
      await post(started, ivan, payment());
      await until(started, "written");
      const id = (await started.query<{ id: string }>("SELECT id::text FROM onec_outbox"))[0]!.id;
      const pool = poolOf(started);

      await expect(onecRetry(pool, id)).rejects.toThrow(AdminError);
      await expect(onecSkip(pool, id)).rejects.toThrow(AdminError);
      await expect(onecRetry(pool, "9999")).rejects.toThrow(/No payment 9999/);
      await expect(onecSkip(pool, undefined)).rejects.toThrow(/--id/);
      await expect(onecSkip(pool, "1; DROP TABLE operations")).rejects.toThrow(/--id/);
      expect(await queued(started)).toEqual([expect.objectContaining({ status: "written" })]);
    });

    it("onec-skip stops a payment that waits: it is never written, even when the client turns up", async () => {
      const { started, ivan } = await desk();
      await post(started, ivan, payment());
      await until(started, "blocked");
      const id = (await started.query<{ id: string }>("SELECT id::text FROM onec_outbox"))[0]!.id;

      const message = await onecSkip(poolOf(started), id);
      onec.addClient("А406", "Жавид");
      await settle();

      expect(message).toContain("will not be written");
      expect(await queued(started)).toEqual([expect.objectContaining({ status: "skipped" })]);
      expect(onec.documents).toEqual([]);
    });
  });
});
