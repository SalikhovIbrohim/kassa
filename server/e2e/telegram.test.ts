import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { signedLaunch } from "../test/helpers/telegram.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const TOKEN = "123456:TEST-token-of-the-bot";

/** The Mini App: the same page, opened with the launch data of Telegram in the fragment of the address. */
describe("the app inside Telegram", () => {
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
    context = undefined;
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp({ webDistDir, telegramBotToken: TOKEN });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const phone = await newPhone(browser);
    context = phone.context;
    const launch = (token = TOKEN) =>
      `${started.baseUrl}/#tgWebAppData=${encodeURIComponent(signedLaunch(token, 777))}&tgWebAppVersion=8.0`;
    return { started, page: phone.page, launch };
  }

  it("asks an account that is not linked for the password, links it on a press, and then opens without a password", async () => {
    const { page, launch } = await desk();
    await page.goto(launch());
    await seeText(page.locator("body"), "Этот Telegram ещё не привязан к логину");

    await page.getByLabel("Логин").fill("ivan");
    await page.getByLabel("Пароль").fill("correct horse");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await page.getByRole("button", { name: "Привязать Telegram" }).click();
    await seeText(page.getByRole("status").filter({ hasText: "Telegram привязан" }), "без пароля");

    await page.getByRole("button", { name: "Выйти" }).click();
    await page.getByLabel("Логин").waitFor();
    await page.goto(launch());
    await page.reload();
    await page.getByRole("button", { name: "Выйти" }).waitFor();

    await seeText(page.locator(".who"), "Иван");
    expect(await page.getByRole("button", { name: "Привязать Telegram" }).count()).toBe(0);
  }, 90_000);

  it("does not sign anybody in on launch data that was not signed by this bot, and shows the ordinary login", async () => {
    const { page, launch } = await desk();

    await page.goto(launch("999999:another-bot"));

    await seeVisible(page.getByRole("button", { name: "Войти" }));
    expect(await page.getByRole("button", { name: "Выйти" }).count()).toBe(0);
  }, 90_000);

  it("is the same app in an ordinary browser: no Telegram note, no link button", async () => {
    const { started, page } = await desk();
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill("ivan");
    await page.getByLabel("Пароль").fill("correct horse");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("button", { name: "Выйти" }).waitFor();

    expect(await page.getByRole("button", { name: "Привязать Telegram" }).count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toContain("Telegram");
  }, 90_000);
});
