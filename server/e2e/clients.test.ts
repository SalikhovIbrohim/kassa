import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { get, loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { cashMenu, launchChromium, newLaptop, newPhone, openSection, seeText } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The directory of clients: kept by the admin in «Управление», offered in the income form. */
describe("the clients on the screen", () => {
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

  const clientsOf = async (started: TestApp, cookie: string) =>
    ((await (await get(started, "/api/operations", cookie)).json()).operations as Array<{ clientCode: string | null }>).map((operation) => operation.clientCode);

  it("are added by the admin in «Клиенты», offered as the code is typed, and a payment names the client the directory's way", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "anvar", password: "admin pass word", role: "head_cashier", displayName: "Анвар" });

    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    await signIn(laptop.page, started, "mudir", "admin password");
    await cashMenu(laptop.page, "Управление");
    await openSection(laptop.page, "Клиенты");
    await laptop.page.getByRole("button", { name: "+ Новый", exact: true }).click();
    const dialog = laptop.page.getByRole("dialog", { name: "Новый клиент" });
    await dialog.getByRole("textbox", { name: /Код/ }).fill("a707");
    await dialog.getByRole("textbox", { name: "Имя" }).fill("Карим");
    await dialog.getByRole("button", { name: "Добавить" }).click();
    await seeText(laptop.page.locator(".success:visible"), "Добавлен клиент");
    await laptop.page.getByText("А707", { exact: true }).locator("visible=true").first().waitFor();

    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await signIn(page, started, "anvar", "admin pass word");
    const form = page.locator("form:visible").first();
    const code = form.locator("input[name=clientCode]");

    // «А70» brings «А707 Карим» up among the suggestions.
    await code.fill("А70");
    await expect.poll(() => page.getByRole("listbox", { name: "Клиенты" }).getByRole("option").allInnerTexts()).toContain("А707 Карим");
    await form.getByRole("textbox", { name: "Сумма" }).fill("1000");
    await page.locator("input[name=rate]:visible").fill("80");
    await code.fill("a707");
    await form.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success:visible"), /Записано: приход/);

    // Clients are added in «Клиенты» only: the form has no button for it.
    expect(await form.getByRole("button", { name: /Новый/ }).count()).toBe(0);
    await expect.poll(async () => clientsOf(started, await loginAs(started, "mudir", "admin password"))).toEqual(["А707 Карим"]);
  }, 120_000);

  it("tells the cashier a client is not in the directory, and offers no button to add one", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const mudir = await loginAs(started, "mudir", "admin password");
    await postJson(started, "/api/admin/clients", { code: "А707", name: "Карим" }, mudir);

    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await signIn(page, started, "ivan", "correct horse");
    const form = page.locator("form:visible").first();
    expect(await form.getByRole("button", { name: /Новый/ }).count()).toBe(0);
    await form.getByRole("textbox", { name: "Сумма" }).fill("1000");
    await page.locator("input[name=rate]:visible").fill("80");
    await form.locator("input[name=clientCode]").fill("А708");
    await form.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator("[role=alert]:visible").first(), "Такого клиента нет в справочнике");
  }, 90_000);
});
