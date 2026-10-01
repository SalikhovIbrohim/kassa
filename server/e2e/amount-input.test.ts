import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeText, seeValue } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The amount field on the phone: thousands are separated while the cashier types. */
describe("the amount field", () => {
  let browser: Browser;
  let app: TestApp | undefined;
  let context: BrowserContext | undefined;

  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    await context?.close();
    await app?.close();
    context = undefined;
    app = undefined;
  });

  it("separates the thousands as the digits are typed, keeps the caret where it was, and saves the right amount", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const phone = await newPhone(browser);
    context = phone.context;
    const page = phone.page;
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill("ivan");
    await page.getByLabel("Пароль").fill("correct horse");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("button", { name: "Выйти" }).waitFor();

    const amount = page.getByRole("textbox", { name: "Сумма" });
    await amount.click();
    await amount.pressSequentially("500000");
    await seeValue(amount, "500 000");

    // A digit put at the very beginning: the caret stays after it, and the next digit goes next to it.
    await amount.press("Home");
    await amount.pressSequentially("12");
    await seeValue(amount, "12 500 000");

    await amount.fill("");
    await amount.pressSequentially("1500,505");
    await seeValue(amount, "1 500,50");

    await amount.fill("");
    await amount.pressSequentially("250000");
    await page.locator("input[name=clientCode]").fill("AMT-1");
    await page.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success"), /Записано: приход 250\s000,00\s₽/);
    await seeValue(amount, "");
  }, 90_000);
});
