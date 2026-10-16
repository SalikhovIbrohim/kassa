import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { get, loginAs, patchJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newLaptop, newPhone, seeText, choose, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The cash desks of Moscow and Andijan on the screen: a cashier of Andijan in dollars only, the admin switching. */
describe("two cash desks", () => {
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

  async function desk() {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "ali", password: "andijan cashier", role: "cashier", displayName: "Али" });
    await started.admin.setOpeningBalance("RUB", "1000");
    await started.admin.setOpeningBalance("USD", "50");
    const mudir = await loginAs(started, "mudir", "admin password");
    const users = (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ id: string; login: string }>;
    await patchJson(started, `/api/admin/users/${users.find((user) => user.login === "ali")!.id}`, { city: "andijan" }, mudir);

    const signIn = async (page: Page, login: string, password: string) => {
      await page.goto(started.baseUrl);
      await page.getByLabel("Логин").fill(login);
      await page.getByLabel("Пароль").fill(password);
      await page.getByRole("button", { name: "Войти" }).click();
      await page.locator("[data-signed-in]:visible").first().waitFor();
    };
    return { started, signIn, mudir };
  }

  const balances = (page: Page) => page.getByRole("region", { name: "Остатки" }).first();

  it("gives a cashier of Andijan his desk in dollars: no currency to choose, his balance only", async () => {
    const { signIn } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "ali", "andijan cashier");

    await page.getByRole("tab", { name: "Расход", exact: true }).click();
    const form = page.locator("form:visible").first();
    expect(await form.getByText("Рубли", { exact: true }).count()).toBe(0);
    await choose(selectField(form, "category"), "fuel_road");
    await form.getByRole("textbox", { name: "Сумма" }).fill("20");
    await form.getByRole("button", { name: "Записать расход" }).click();

    await seeText(balances(page), /20,00\s\$/);
    expect(await balances(page).textContent()).not.toContain("₽");
    // There is no desk to switch to.
    expect(await page.getByRole("group", { name: "Касса" }).count()).toBe(0);
  }, 90_000);

  it("lets the admin switch between the desks: the header shows the balances of the one chosen", async () => {
    const { signIn } = await desk();
    const { context, page } = await newLaptop(browser);
    contexts.push(context);
    await signIn(page, "mudir", "admin password");

    await seeText(balances(page), /1\s000,00\s₽/);
    await page.getByRole("group", { name: "Касса" }).first().getByRole("button", { name: "Андижан" }).click();
    await seeText(balances(page), /0,00\s\$/);
    expect(await balances(page).textContent()).not.toContain("₽");
    await seeText(page.locator(".kassa-name:visible"), "Андижан");

    await page.getByRole("group", { name: "Касса" }).first().getByRole("button", { name: "Москва" }).click();
    await seeText(balances(page), /1\s000,00\s₽/);
  }, 90_000);

  it("keeps the category after an expense, with its trip field, so the next one of the kind is typed at once", async () => {
    const { started, signIn, mudir } = await desk();
    await patchJson(started, "/api/admin/categories/customs", { requiresTrip: true }, mudir);
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "ali", "andijan cashier");
    await page.getByRole("tab", { name: "Расход", exact: true }).click();
    const form = page.locator("form:visible").first();
    await choose(selectField(form, "category"), "customs");

    for (const trip of ["101", "102"]) {
      await form.locator("input[name=tripNumber]").fill(trip);
      await form.getByRole("textbox", { name: "Сумма" }).fill("1");
      await form.getByRole("button", { name: "Записать расход" }).click();
      await expect.poll(() => form.locator("input[name=tripNumber]").inputValue()).toBe("");
      await seeText(page.locator(".success:visible"), "Таможня");
      await seeText(selectField(form, "category"), "Таможня");
    }
    await expect.poll(async () => ((await (await get(started, "/api/operations?kassa=andijan", mudir)).json()).operations as Array<{ tripNumber: number | null }>).map((operation) => operation.tripNumber).sort()).toEqual([101, 102]);
  }, 90_000);
});
