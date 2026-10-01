import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeValue, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The rate of a ruble entry, on the phone: shown with rubles, hidden with dollars, counted in dollars. */
describe("the rate field", () => {
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

  async function signedIn(started: TestApp, login: string, password: string) {
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await phone.page.goto(started.baseUrl);
    await phone.page.getByLabel("Логин").fill(login);
    await phone.page.getByLabel("Пароль").fill(password);
    await phone.page.getByRole("button", { name: "Войти" }).click();
    await phone.page.getByRole("button", { name: "Выйти" }).waitFor();
    return phone;
  }

  const amountField = (page: Page) => page.getByRole("textbox", { name: "Сумма" });
  const rateField = (page: Page) => page.locator("input[name=rate]:visible");

  it("is asked for an income in rubles, optional for an expense, gone with dollars, and counted in dollars for the owner", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const { page } = await signedIn(started, "ivan", "correct horse");

    // An income: the rate is there with rubles, and cannot be left out.
    await seeVisible(rateField(page));
    await amountField(page).fill("79000");
    await page.locator("input[name=clientCode]").fill("RATE-1");
    await page.getByRole("button", { name: "Записать приход" }).click();
    // The browser itself stops the form: the rate is a required field.
    await seeVisible(page.locator("input[name=rate]:visible:invalid"));
    expect(await page.locator(".success").count()).toBe(0);

    // With dollars there is no rate to ask for.
    await page.getByRole("radio", { name: "Доллары" }).check();
    await seeGone(rateField(page));
    await page.getByRole("radio", { name: "Рубли" }).check();

    await rateField(page).fill("79");
    await page.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success"), "Записано: приход");
    // The rate stays for the next entry of the day.
    await seeValue(rateField(page), "79");

    // An expense: its rate may stay empty.
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await amountField(page).fill("1000");
    await page.getByText("Топливо и дорога").click();
    await seeValue(rateField(page), "");
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(page.locator(".success:visible"), "Записано: Топливо и дорога");

    // The journal says what the income is in dollars.
    await page.getByRole("button", { name: "Журнал", exact: true }).click();
    await seeText(page.getByRole("table", { name: "Журнал операций" }), "RATE-1");
    await seeVisible(page.locator(".usd-note", { hasText: "в долларах после закрытия смены" }));
    await seeText(page.locator('.usd-note[data-usd="100000"]'), /≈\s*1\s000,00\s\$ · курс 79,00/);

    // The owner reads the day in dollars.
    const owner = await signedIn(started, "owner", "long enough pass");
    await owner.page.getByRole("button", { name: "Итоги", exact: true }).click();
    await seeText(owner.page.locator('[data-usd="income"]'), /\+1\s000,00\s\$/);
    await seeText(owner.page.locator("[data-without-rate=expense]"), "расходов в рублях без курса: 1");
    expect(await owner.page.locator('[data-usd="result"]').innerText()).toMatch(/\+1\s000,00\s\$/);

    // The next time the form opens it starts with the rate of today.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await seeValue(rateField(page), "79");
  }, 120_000);
});
