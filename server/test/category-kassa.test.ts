import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { deleteRequest, get, loginAs, patchJson, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type Json = Record<string, unknown>;
type Balance = { currency: string; amountMinor: number };

/**
 * A category that sends its money into one cash desk. The owner takes a payment of a client in Tashkent and rings
 * Moscow to have it written down: the cashier of Moscow enters it without leaving their own desk, and it is an income
 * of Tashkent.
 */
describe("a category whose money goes into another cash desk", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Three desks of dollars; a cashier of Moscow, one of Tashkent, the admin and the owner (people of everywhere). */
  async function business() {
    const started = await startTestApp({ kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), clientCodes: "digits", warehouses: parseWarehouses("andijan,tashkent") });
    app = started;
    started.setNow(new Date("2026-11-18T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const mudir = await loginAs(started, "mudir", "admin password");
    const person = async (login: string, displayName: string, city: string) => {
      expect((await postJson(started, "/api/admin/users", { login, displayName, password: "some long pass", role: "cashier", city }, mudir)).status, login).toBe(201);
      return loginAs(started, login, "some long pass");
    };
    const ivan = await person("ivan", "Иван", "moscow");
    const timur = await person("timur", "Тимур", "tashkent");
    expect((await postJson(started, "/api/admin/clients/import", { clients: [{ code: "132", name: "Иброхим", openingDebtMinor: 500_000 }] }, mudir)).status).toBe(200);
    await started.admin.setOpeningBalance("USD", "1000", "moscow");
    await started.admin.setOpeningBalance("USD", "200", "tashkent");
    // «Клиент дал деньги в Ташкенте»: a payment of a client, offered in Moscow, booked into Tashkent.
    const made = await postJson(started, "/api/admin/categories", { kind: "income", label: "Клиент дал деньги в Ташкенте", requiresClient: true, city: "moscow", intoKassa: "tashkent" }, mudir);
    expect(made.status).toBe(201);
    const category = ((await made.json()) as { category: { code: string; intoKassa: string | null } }).category;
    expect(category.intoKassa).toBe("tashkent");
    return { started, mudir, ivan, timur, owner: await loginAs(started, "owner", "long enough pass"), category: category.code };
  }

  const balanceOf = async (started: TestApp, cookie: string, kassa?: string) =>
    ((await (await get(started, `/api/balances${kassa ? `?kassa=${kassa}` : ""}`, cookie)).json()) as { balances: Balance[] }).balances.find((item) => item.currency === "USD")!.amountMinor;
  const income = (category: string, amountMinor: number, more: Json = {}): Json => ({ id: randomUUID(), type: "income", amountMinor, currency: "USD", category, clientCode: "132", ...more });

  it("books the entry of a cashier of Moscow into the desk of Tashkent: the balance of Tashkent moves, the one of Moscow does not", async () => {
    const { started, mudir, ivan, timur, category } = await business();
    const entry = income(category, 60_000);
    const saved = await postJson(started, "/api/operations", entry, ivan);
    expect(saved.status).toBe(201);
    const body = (await saved.json()) as { operation: { kassa: string; category: string }; balances: Balance[] };
    expect(body.operation).toMatchObject({ kassa: "tashkent", category });
    // The cashier is answered with the balance of their own desk, as it was: the money is not there.
    expect(body.balances).toEqual([{ currency: "USD", amountMinor: 100_000 }]);
    expect(await balanceOf(started, ivan)).toBe(100_000);
    expect(await balanceOf(started, timur)).toBe(80_000);
    expect(await balanceOf(started, mudir, "tashkent")).toBe(80_000);
    // Sent again (a phone that did not hear the answer): stored once, answered the same.
    const again = await postJson(started, "/api/operations", entry, ivan);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { balances: Balance[] }).balances).toEqual([{ currency: "USD", amountMinor: 100_000 }]);
    expect(await balanceOf(started, timur)).toBe(80_000);
    // The desk the form names does not matter, and neither does that the cashier may not work in Tashkent otherwise.
    expect(((await (await postJson(started, "/api/operations", income(category, 1_000, { kassa: "moscow" }), ivan)).json()) as { operation: { kassa: string } }).operation.kassa).toBe("tashkent");
    expect((await postJson(started, "/api/operations", income("client_payment", 1_000, { kassa: "tashkent" }), ivan)).status).toBe(403);
    // An ordinary payment in Moscow is of Moscow, as it always was.
    expect(((await (await postJson(started, "/api/operations", income("client_payment", 5_000), ivan)).json()) as { operation: { kassa: string } }).operation.kassa).toBe("moscow");
    expect(await balanceOf(started, ivan)).toBe(105_000);
    expect(await balanceOf(started, timur)).toBe(81_000);

    // It is a payment of the client like any other: the debt goes down, and the report of the day names the desk that took it.
    const client = ((await (await get(started, "/api/clients?q=132", mudir)).json()) as { clients: Array<{ code: string; debtMinor: number }> }).clients[0]!;
    expect(client.debtMinor).toBe(500_000 - 60_000 - 1_000 - 5_000);
    const report = (await (await get(started, "/api/debts/report", mudir)).json()) as { paidElsewhere: unknown; payers: Array<{ kassas: string[] }> };
    expect(report.paidElsewhere).toEqual([{ kassa: "tashkent", amountMinor: 61_000 }]);
    expect(report.payers[0]!.kassas).toEqual(["tashkent"]);
  });

  it("shows the entry in the journal of Tashkent, and to the cashier of Moscow who wrote it, who may correct and delete it", async () => {
    const { started, ivan, timur, owner, category } = await business();
    const entry = income(category, 60_000);
    expect((await postJson(started, "/api/operations", entry, ivan)).status).toBe(201);
    expect((await postJson(started, "/api/operations", income("client_payment", 5_000), timur)).status).toBe(201);
    const journal = async (cookie: string, query = "") =>
      ((await (await get(started, `/api/operations${query}`, cookie)).json()) as { operations: Array<{ id: string; kassa: string; amountMinor: number }> }).operations.map((item) => `${item.kassa} ${item.amountMinor}`).sort();
    // (Both were written in one instant of the test's clock: read in the order of their sums.)
    // Tashkent sees both entries of its desk; Moscow sees its own one that went there, and not the other.
    expect(await journal(timur)).toEqual(["tashkent 5000", "tashkent 60000"]);
    expect(await journal(ivan)).toEqual(["tashkent 60000"]);
    expect(await journal(owner, "?kassa=moscow")).toEqual([]);
    expect(await journal(owner, "?kassa=tashkent")).toEqual(["tashkent 5000", "tashkent 60000"]);

    // The sum was 650, not 600: corrected by its author, and it is the balance of Tashkent that follows.
    const corrected = await putJson(started, `/api/operations/${entry.id as string}`, { type: "income", amountMinor: 65_000, currency: "USD", category, clientCode: "132" }, ivan);
    expect(corrected.status).toBe(200);
    expect(((await corrected.json()) as { operation: { kassa: string }; balances: Balance[] })).toMatchObject({ operation: { kassa: "tashkent" }, balances: [{ currency: "USD", amountMinor: 100_000 }] });
    expect(await balanceOf(started, timur)).toBe(20_000 + 5_000 + 65_000);
    expect(await balanceOf(started, ivan)).toBe(100_000);
    // Deleted: Tashkent is as it was without it.
    expect((await deleteRequest(started, `/api/operations/${entry.id as string}`, ivan)).status).toBe(200);
    expect(await balanceOf(started, timur)).toBe(25_000);
  });

  it("keeps an entry in the desk it was written into: it cannot be given a category of another desk afterwards", async () => {
    const { started, mudir, ivan, category } = await business();
    const ordinary = income("client_payment", 5_000);
    expect((await postJson(started, "/api/operations", ordinary, ivan)).status).toBe(201);
    const moved = await putJson(started, `/api/operations/${ordinary.id as string}`, { type: "income", amountMinor: 5_000, currency: "USD", category, clientCode: "132" }, ivan);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "category_of_another_kassa" });
    expect(await balanceOf(started, ivan)).toBe(105_000);

    // The admin takes the desk off the category: from then on its entries are of the desk of whoever writes them.
    const plain = await patchJson(started, `/api/admin/categories/${category}`, { intoKassa: null }, mudir);
    expect(((await plain.json()) as { category: { intoKassa: string | null } }).category.intoKassa).toBeNull();
    expect(((await (await postJson(started, "/api/operations", income(category, 1_000), ivan)).json()) as { operation: { kassa: string } }).operation.kassa).toBe("moscow");
    // And puts another on it; a desk the business does not have is refused.
    expect(((await (await patchJson(started, `/api/admin/categories/${category}`, { intoKassa: "andijan" }, mudir)).json()) as { category: { intoKassa: string | null } }).category.intoKassa).toBe("andijan");
    expect((await patchJson(started, `/api/admin/categories/${category}`, { intoKassa: "kokand" }, mudir)).status).toBe(400);
    // The cashiers read where the money of a category goes: their form warns them before it is written.
    const lists = (await (await get(started, "/api/categories", ivan)).json()) as { income: Array<{ code: string; intoKassa: string | null }> };
    expect(lists.income.find((item) => item.code === category)!.intoKassa).toBe("andijan");
    expect(lists.income.find((item) => item.code === "client_payment")!.intoKassa).toBeNull();
  });
});
