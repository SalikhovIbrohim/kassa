import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { backToCashDesk, launchChromium, newLaptop, newPhone, openSection, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The frame: a menu on the left on a computer with the section and «Выйти» in the header; a tab bar on a phone. */
describe("the frame of the app", () => {
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

  it("on a computer the admin goes between the forms and the other sections, and keeps where he was in each", async () => {
    const started = await desk();
    const page = await signedIn(await newLaptop(browser), started, "mudir", "admin password");

    await openSection(page, "Люди");
    await seeText(heading(page), "Люди");
    await seeVisible(page.getByRole("region", { name: "Пользователи" }));

    await backToCashDesk(page);
    await seeText(heading(page), "Приход");
    await seeVisible(page.getByLabel("Сумма").locator("visible=true").first());
    // No tab bar on a computer: the menu on the left has every section.
    expect(await page.getByRole("tablist", { name: "Основные разделы" }).isVisible()).toBe(false);
    await openSection(page, "Люди");
    await seeText(heading(page), "Люди");
  }, 90_000);

  it("on a phone the tab bar steps aside while the keyboard is up, and comes back when it goes", async () => {
    const started = await desk();
    const page = await signedIn(await newPhone(browser), started, "mudir", "admin password");
    const tabs = page.getByRole("tablist", { name: "Основные разделы" });
    await seeVisible(tabs);

    // The keyboard: a text field has the focus and the screen gets shorter.
    await page.getByLabel("Сумма").locator("visible=true").first().focus();
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(() => tabs.isVisible()).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await seeVisible(tabs);

    // The keyboard closed while the field kept the focus (Android's back button) or the field let go: the bar is back.
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(() => tabs.isVisible()).toBe(false);
    await page.getByLabel("Сумма").locator("visible=true").first().blur();
    await seeVisible(tabs);
  }, 90_000);

  it("on a phone a tab bar at the bottom, «Настройки» last, from where the other sections open", async () => {
    const started = await desk();
    const page = await signedIn(await newPhone(browser), started, "owner", "long enough pass");

    await seeGone(page.getByRole("navigation", { name: "Разделы" }));
    const tabs = page.getByRole("tablist", { name: "Основные разделы" });
    await seeVisible(tabs);
    expect(await tabs.getByRole("tab").allInnerTexts()).toEqual(["Журнал", "Итоги", "Сверки", "Клиенты", "Настройки"]);
    expect(await tabs.getByRole("tab", { name: "Журнал" }).getAttribute("aria-selected")).toBe("true");

    // «Категории» is not on the tab bar: it opens from «Настройки», with the way back.
    await openSection(page, "Категории");
    await seeText(page.locator("h2:visible").first(), "Категории");
    expect(await tabs.getByRole("tab", { name: "Настройки" }).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await seeVisible(page.getByRole("navigation", { name: "Все разделы" }));

    // The tab bar is the person's own: «Категории» instead of «Клиенты», kept on the phone.
    await page.getByRole("button", { name: "Настроить нижнюю панель" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Убрать с панели: Клиенты" }).click();
    await dialog.getByRole("button", { name: "На панель: Категории" }).click();
    await dialog.getByRole("button", { name: "Сохранить" }).click();
    await seeGone(dialog);
    await page.reload();
    await seeVisible(tabs.getByRole("tab", { name: "Категории", exact: true }));
    expect(await tabs.getByRole("tab", { name: "Клиенты", exact: true }).count()).toBe(0);

    // «Выйти» lives in «Настройки» on a phone.
    await tabs.getByRole("tab", { name: "Настройки" }).click();
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await seeVisible(page.getByRole("button", { name: "Войти" }));
  }, 90_000);
});
