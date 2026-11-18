import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { parseKassas } from "../src/kassa.js";
import { get, loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newLaptop, newPhone, openSection, seeGone, seeText, seeVisible, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The owner takes the money of a client in Tashkent and rings Moscow to have it written down. The cashier of Moscow
 * enters it under a category that sends its money into the desk of Tashkent, and is asked first: this is money of
 * Tashkent, not of Moscow.
 */
describe("an income written in Moscow into the desk of Tashkent", () => {
  let browser: Browser;
  let app: TestApp | undefined;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
    await app?.close();
    app = undefined;
  });

  async function signIn(page: Page, started: TestApp, login: string, password: string) {
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill(login);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();
  }

  async function business() {
    const started = await startTestApp({ webDistDir, kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), clientCodes: "digits" });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    expect((await postJson(started, "/api/admin/users", { login: "ivan", displayName: "Иван", password: "correct horse", role: "cashier", city: "moscow" }, mudir)).status).toBe(201);
    expect((await postJson(started, "/api/admin/clients/import", { clients: [{ code: "132", name: "Иброхим" }] }, mudir)).status).toBe(200);
    await started.admin.setOpeningBalance("USD", "1000", "moscow");
    await started.admin.setOpeningBalance("USD", "200", "tashkent");
    return { started, mudir };
  }

  const balances = (page: Page) => page.getByRole("region", { name: "Остатки" }).first();
  const asked = (page: Page) => page.getByRole("dialog", { name: "Это деньги кассы Ташкента" });
  const tashkent = async (started: TestApp, cookie: string) =>
    ((await (await get(started, "/api/balances?kassa=tashkent", cookie)).json()) as { balances: Array<{ amountMinor: number }> }).balances[0]!.amountMinor;

  it("is set up by the admin on the category, and the cashier is asked before the money goes to the other desk", async () => {
    const { started, mudir } = await business();
    // The admin makes the category on a laptop and says which desk its money goes into.
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    await signIn(laptop.page, started, "mudir", "admin password");
    await openSection(laptop.page, "Категории");
    await laptop.page.getByRole("button", { name: "+ Новая" }).click();
    const form = laptop.page.getByRole("dialog", { name: "Новая категория" });
    await form.getByText("Приход", { exact: true }).click();
    await form.locator("input[name=label]").fill("Клиент дал деньги в Ташкенте");
    await form.getByRole("checkbox", { name: "Нужен код клиента" }).check();
    await choose(selectField(form, "intoKassa"), { label: "Ташкент" });
    await form.getByRole("button", { name: "Добавить" }).click();
    await seeVisible(laptop.page.getByRole("combobox", { name: "В кассу: Клиент дал деньги в Ташкенте" }));
    await seeText(laptop.page.getByRole("combobox", { name: "В кассу: Клиент дал деньги в Ташкенте" }), "Ташкент");
    // Every other category goes where it always went.
    await seeText(laptop.page.getByRole("combobox", { name: "В кассу: Оплата от клиента" }), "Кассира");

    // The cashier of Moscow, on a phone: 600 $ of the client 132, taken in Tashkent.
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await signIn(page, started, "ivan", "correct horse");
    await seeText(balances(page), /1\s000,00\s\$/);
    await choose(selectField(page, "category"), { label: "Клиент дал деньги в Ташкенте" });
    await page.locator("input[name=clientCode]:visible").fill("132");
    await page.locator("input[name=amount]:visible").fill("600");
    await page.getByRole("button", { name: "Записать приход" }).click();
    // Asked first, in so many words.
    await seeVisible(asked(page));
    await seeText(asked(page), /Приход 600,00\s\$ будет записан в кассу Ташкента, а не Москвы\./);
    await seeText(asked(page), "Остаток кассы Москвы не изменится");
    // «Отмена»: nothing is written, the form is as it was.
    await asked(page).getByRole("button", { name: "Отмена" }).click();
    await seeGone(asked(page));
    expect(await tashkent(started, mudir)).toBe(20_000);
    expect(await page.locator("input[name=amount]:visible").inputValue()).toBe("600");

    // Again, and «Да»: it is written into Tashkent, and the screen says so.
    await page.getByRole("button", { name: "Записать приход" }).click();
    await asked(page).getByRole("button", { name: "Да, записать в кассу Ташкента" }).click();
    await seeText(page.locator(".success:visible"), /Записано в кассу Ташкента: приход 600,00\s\$/);
    expect(await tashkent(started, mudir)).toBe(80_000);
    // The balance of Moscow on the cashier's screen has not moved.
    await seeText(balances(page), /1\s000,00\s\$/);

    // An ordinary payment asks nothing and is of Moscow.
    await choose(selectField(page, "category"), { label: "Оплата от клиента" });
    await page.locator("input[name=clientCode]:visible").fill("132");
    await page.locator("input[name=amount]:visible").fill("50");
    await page.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success:visible"), /Записано: приход 50,00\s\$/);
    await seeText(balances(page), /1\s050,00\s\$/);
    expect(await asked(page).count()).toBe(0);

    // In the cashier's journal the entry of Tashkent is there, marked with its desk; the one of Moscow has no mark.
    await openSection(page, "Журнал");
    const rows = page.locator("table:visible tbody tr.income");
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(2);
    await seeText(rows.filter({ hasText: "600,00" }).locator(".kassa-mark"), "ТШК");
    expect(await rows.filter({ hasText: "50,00" }).locator(".kassa-mark").count()).toBe(0);
  });
});
