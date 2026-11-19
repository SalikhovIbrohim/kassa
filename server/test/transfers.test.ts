import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseKassas } from "../src/kassa.js";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { keyOf, KEYS, startFakeOneC, type FakeOneC } from "./helpers/fake-onec.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Json = Record<string, unknown>;
type Operation = Json & { id: string; type: string; kassa: string; amountMinor: number; category: string; toKassa: string | null; transferOf: string | null; comment: string | null; deletedAt: string | null };

/** Money moved from one cash desk to another is entered once, by the desk that sends it, and both desks have it at once. */
describe("money moved between the cash desks", () => {
  let app: TestApp | undefined;
  let onec: FakeOneC | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await onec?.close();
    onec = undefined;
  });

  async function business(options: Parameters<typeof startTestApp>[0] = {}) {
    const started = await startTestApp({ kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), ...options });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const made = await postJson(started, "/api/admin/users", { login: "moskva", displayName: "Кассир Москвы", password: "some long pass", role: "cashier", city: "moscow" }, mudir);
    expect(made.status).toBe(201);
    const category = async (body: Json) => {
      const answer = await postJson(started, "/api/admin/categories", body, mudir);
      expect(answer.status).toBe(201);
      return ((await answer.json()) as { category: { code: string } }).category.code;
    };
    const out = await category({ kind: "expense", label: "Внутреннее перемещение денежных средств", transfer: true });
    const into = await category({ kind: "income", label: "Внутреннее перемещение денежных средств", transfer: true });
    return { started, mudir, cashier: await loginAs(started, "moskva", "some long pass"), out, into };
  }

  const balanceOf = async (started: TestApp, cookie: string, kassa: string) =>
    ((await (await get(started, `/api/balances?kassa=${kassa}`, cookie)).json()) as { balances: Array<{ amountMinor: number }> }).balances[0]!.amountMinor;
  const journal = async (started: TestApp, cookie: string) =>
    ((await (await get(started, "/api/operations?deleted=include", cookie)).json()) as { operations: Operation[] }).operations;
  const moved = (out: string, more: Json = {}): Json => ({ id: randomUUID(), type: "expense", amountMinor: 300_000, currency: "USD", category: out, toKassa: "tashkent", ...more });

  it("takes the money out of the desk that sends it and puts it into the desk named, as two entries written together", async () => {
    const { started, mudir, cashier, out, into } = await business();
    const body = moved(out, { comment: "через Жахонгира" });

    const answer = await postJson(started, "/api/operations", body, cashier);

    expect(answer.status).toBe(201);
    expect(((await answer.json()) as { operation: Operation }).operation).toMatchObject({ kassa: "moscow", toKassa: "tashkent", transferOf: null });
    expect(await balanceOf(started, mudir, "moscow")).toBe(-300_000);
    expect(await balanceOf(started, mudir, "tashkent")).toBe(300_000);
    expect(await balanceOf(started, mudir, "andijan")).toBe(0);
    const income = (await journal(started, mudir)).find((item) => item.type === "income")!;
    expect(income).toMatchObject({ kassa: "tashkent", amountMinor: 300_000, category: into, transferOf: body.id, comment: "Из кассы Москва: через Жахонгира" });

    // Sent again (the answer was lost): nothing is added.
    expect((await postJson(started, "/api/operations", body, cashier)).status).toBe(200);
    expect(await balanceOf(started, mudir, "tashkent")).toBe(300_000);
    expect(await journal(started, mudir)).toHaveLength(2);
  });

  it("asks which desk, and refuses the desk itself, a desk for any other category and an income of the category entered by hand", async () => {
    const { started, cashier, out, into } = await business();
    const post = async (body: Json) => (await postJson(started, "/api/operations", body, cashier)).status;

    expect(await post(moved(out, { toKassa: undefined }))).toBe(400);
    expect(await post(moved(out, { toKassa: "moscow" }))).toBe(400);
    expect(await post(moved(out, { toKassa: "kokand" }))).toBe(400);
    expect(await post(moved("other"))).toBe(400);
    expect(await post({ id: randomUUID(), type: "income", amountMinor: 1_000, currency: "USD", category: into })).toBe(400);
  });

  it("corrects and deletes both sides through the expense, and leaves the income alone by itself", async () => {
    const { started, mudir, cashier, out } = await business();
    const body = moved(out);
    await postJson(started, "/api/operations", body, cashier);
    const income = (await journal(started, mudir)).find((item) => item.type === "income")!;

    // The income of the other desk is not corrected or deleted by itself.
    expect((await putJson(started, `/api/operations/${income.id}`, { type: "income", amountMinor: 1, currency: "USD", category: income.category }, mudir)).status).toBe(409);
    expect(await (await deleteRequest(started, `/api/operations/${income.id}`, mudir, { reason: "ошибка" })).json()).toEqual({ error: "transfer_income" });

    // The sum is put right on both sides; the desk it went to and the category stay.
    const edit = (more: Json) => putJson(started, `/api/operations/${String(body.id)}`, { type: "expense", amountMinor: 250_000, currency: "USD", category: out, reason: "сумма", ...more }, cashier);
    expect((await edit({ toKassa: "andijan" })).status).toBe(409);
    expect((await edit({ category: "other" })).status).toBe(409);
    expect((await edit({})).status).toBe(200);
    expect(await balanceOf(started, mudir, "moscow")).toBe(-250_000);
    expect(await balanceOf(started, mudir, "tashkent")).toBe(250_000);
    // And no other expense becomes money moved.
    const plain = { id: randomUUID(), type: "expense", amountMinor: 100, currency: "USD", category: "other" };
    await postJson(started, "/api/operations", plain, cashier);
    expect((await putJson(started, `/api/operations/${plain.id}`, { ...plain, id: undefined, category: out, toKassa: "tashkent" }, cashier)).status).toBe(409);

    expect((await deleteRequest(started, `/api/operations/${String(body.id)}`, cashier, { reason: "не передали" })).status).toBe(200);
    expect(await balanceOf(started, mudir, "moscow")).toBe(-100);
    expect(await balanceOf(started, mudir, "tashkent")).toBe(0);
    expect((await journal(started, mudir)).filter((item) => item.deletedAt !== null)).toHaveLength(2);
  });

  it("goes to 1C as one expense order of the desk that sent it, naming the desk it went to", async () => {
    onec = await startFakeOneC();
    const tashkent = "5975b80b-55e9-11f1-8cb6-b8cb29f61f4c";
    const { started, cashier, out } = await business({
      onec: { url: onec.url, user: onec.user, password: onec.password, organizationKey: KEYS.organization, kassaKey: KEYS.kassa, currencyKey: KEYS.currency, kassaKeys: { tashkent }, mode: "live", documents: ["expenses", "incomes"] },
      onecKassas: ["moscow", "tashkent"],
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
    });

    await postJson(started, "/api/operations", moved(out, { comment: "через Жахонгира" }), cashier);
    let rows: Array<{ status: string }> = [];
    for (let attempt = 0; attempt < 200 && !rows.some((row) => row.status === "written"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rows = await started.query<{ status: string }>("SELECT status FROM onec_outbox");
    }

    // One row in the queue and one order: the income of the other desk is not written by itself.
    expect(rows).toEqual([{ status: "written" }]);
    expect(onec.documents).toHaveLength(0);
    expect(onec.expenses).toHaveLength(1);
    expect(onec.expenses[0]).toMatchObject({
      ВидОперации: "ПрочийРасход",
      КассаОрганизации_Key: KEYS.kassa,
      СчетУчетаРасчетовСКонтрагентом_Key: "acc-5010",
      СубконтоДт1: keyOf("dds", "Внутреннее перемещение денежных средств"),
      СубконтоДт2: tashkent,
      СубконтоДт2_Type: "StandardODATA.Catalog_КассыОрганизаций",
      СтатьяДвиженияДенежныхСредств_Key: keyOf("dds", "Внутреннее перемещение денежных средств"),
      СуммаДокумента: 3000,
      Комментарий: "В кассу Ташкент через Жахонгира",
      Posted: true,
    });
  });
});
