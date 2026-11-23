import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { parseKassas } from "../src/kassa.js";
import { get, loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newPhone, openSection, seeText, seeVisible, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The cashier of Moscow hands money over to the desk of Tashkent: one entry, and both desks have it at once. */
describe("money moved to another cash desk, on the cashier's phone", () => {
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

  const balances = (page: Page) => page.getByRole("region", { name: "Остатки" }).first();

  it("asks which desk under the category, and writes the expense here and the income there", async () => {
    const started = await startTestApp({ webDistDir, kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD") });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const mudir = await loginAs(started, "mudir", "admin password");
    expect((await postJson(started, "/api/admin/users", { login: "ivan", displayName: "Иван", password: "correct horse", role: "cashier", city: "moscow" }, mudir)).status).toBe(201);
    for (const kind of ["expense", "income"]) {
      expect((await postJson(started, "/api/admin/categories", { kind, label: "Внутреннее перемещение денежных средств", transfer: true }, mudir)).status).toBe(201);
    }
    await started.admin.setOpeningBalance("USD", "1000", "moscow");
    const tashkent = async () => ((await (await get(started, "/api/balances?kassa=tashkent", mudir)).json()) as { balances: Array<{ amountMinor: number }> }).balances[0]!.amountMinor;

    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill("ivan");
    await page.getByLabel("Пароль").fill("correct horse");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();

    // Money moved is not offered among the incomes: it is entered by the desk that sends it.
    expect(await page.locator("select[name=category]:visible option", { hasText: "Внутреннее перемещение" }).count()).toBe(0);

    await openSection(page, "Расход");
    // No desk is asked for an ordinary expense.
    expect(await page.locator("select[name=toKassa]:visible").count()).toBe(0);
    await choose(selectField(page, "category"), { label: "Внутреннее перемещение денежных средств" });
    await seeVisible(page.locator("select[name=toKassa]:visible"));
    // The other desks only: Moscow does not send money to itself.
    expect(await page.locator("select[name=toKassa]:visible option").allTextContents()).toEqual(["Выберите кассу", "Андижан", "Ташкент"]);
    await page.locator("input[name=amount]:visible").fill("300");
    // Without the desk it is not written.
    await page.getByRole("button", { name: "Записать расход" }).click();
    expect(await tashkent()).toBe(0);

    await choose(selectField(page, "toKassa"), { label: "Ташкент" });
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(page.locator(".success:visible"), /Деньги уже в кассе Ташкента/);
    await seeText(balances(page), /700,00\s\$/);
    expect(await tashkent()).toBe(30_000);
  });
});
