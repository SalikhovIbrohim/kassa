import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { backToCashDesk, launchChromium, newLaptop, newPhone, openSection, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** «Управление»: a menu on the left on a computer, behind ☰ on a phone; the balances and «Выйти» in the header. */
describe("the frame of «Управление»", () => {
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

  async function signedIn(device: { context: BrowserContext; page: Page }, started: TestApp, login: string, password: string) {
    contexts.push(device.context);
    await device.page.goto(started.baseUrl);
    await device.page.getByLabel("Логин").fill(login);
    await device.page.getByLabel("Пароль").fill(password);
    await device.page.getByRole("button", { name: "Войти" }).click();
    await device.page.locator("[data-signed-in]:visible").first().waitFor();
    return device.page;
  }

  async function desk() {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.setOpeningBalance("RUB", "1000");
    return started;
  }

  const heading = (page: Page) => page.getByRole("banner").getByRole("heading", { level: 2 });

  it("on a computer: the menu on the left, the section and the balances in the header", async () => {
    const started = await desk();
    const page = await signedIn(await newLaptop(browser), started, "owner", "long enough pass");

    const sections = page.getByRole("navigation", { name: "Разделы" });
    await seeVisible(sections);
    await seeGone(page.getByRole("button", { name: "Меню", exact: true }));
    await seeText(heading(page), "Журнал");
    await seeText(page.getByRole("region", { name: "Остатки" }), /1\s000,00\s₽/);
    await seeVisible(page.getByRole("button", { name: "Выйти", exact: true }));
    await seeText(page.locator(".who:visible"), "Владелец");
    // The owner keeps no accounts and has no cash desk.
    expect(await sections.getByRole("button", { name: "Люди", exact: true }).count()).toBe(0);
    expect(await page.getByRole("group", { name: "Режим" }).count()).toBe(0);

    await openSection(page, "Итоги");
    await seeText(heading(page), "Итоги");
    expect(await sections.getByRole("button", { name: "Итоги", exact: true }).getAttribute("aria-current")).toBe("page");
  }, 90_000);

  it("on a computer the admin goes between the cash desk and «Управление», and keeps the people there", async () => {
    const started = await desk();
    const page = await signedIn(await newLaptop(browser), started, "mudir", "admin password");

    await page.getByRole("tab", { name: "Управление", exact: true }).click();
    await openSection(page, "Люди");
    await seeText(heading(page), "Люди");
    await seeVisible(page.getByRole("region", { name: "Пользователи" }));

    await backToCashDesk(page);
    await seeVisible(page.getByRole("tab", { name: "Приход", exact: true }));
    await page.getByRole("tab", { name: "Управление", exact: true }).click();
    // Where he was is where he comes back to.
    await seeText(heading(page), "Люди");
  }, 90_000);

  it("on a phone the menu hides behind ☰ and closes when a section is chosen", async () => {
    const started = await desk();
    const page = await signedIn(await newPhone(browser), started, "owner", "long enough pass");

    await seeGone(page.getByRole("navigation", { name: "Разделы" }));
    await openSection(page, "Сверки");
    await seeText(heading(page), "Сверки");
    await seeGone(page.getByRole("dialog"));

    // «Выйти» lives in the menu on a phone.
    await page.getByRole("button", { name: "Меню", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Выйти", exact: true }).click();
    await seeVisible(page.getByRole("button", { name: "Войти" }));
  }, 90_000);
});
