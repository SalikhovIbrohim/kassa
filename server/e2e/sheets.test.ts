import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { signedLaunch } from "../test/helpers/telegram.js";
import { launchChromium, newPhone, openSection, seeGone, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const TOKEN = "123456:TEST-token-of-the-bot";

/**
 * Telegram's WebApp, as much of it as the app touches, put on the page before the app starts: full screen on a phone,
 * with the margins Telegram asks for under its own buttons, and a back button that remembers whether it is shown.
 */
const FAKE_TELEGRAM = `
  window.__back = { shown: false, handlers: [] };
  window.Telegram = { WebApp: {
    platform: "android", colorScheme: "light", isFullscreen: true,
    safeAreaInset: { top: 30, bottom: 0, left: 0, right: 0 }, contentSafeAreaInset: { top: 46, bottom: 0, left: 0, right: 0 },
    isVersionAtLeast: () => true, ready() {}, expand() {}, requestFullscreen() {}, disableVerticalSwipes() {},
    setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {}, enableClosingConfirmation() {}, disableClosingConfirmation() {}, onEvent() {},
    BackButton: {
      show() { window.__back.shown = true; }, hide() { window.__back.shown = false; },
      onClick(handler) { window.__back.handlers.push(handler); },
      offClick(handler) { window.__back.handlers = window.__back.handlers.filter((kept) => kept !== handler); },
    },
  } };
`;

/** The windows of the app on a phone: sheets that Telegram's back button closes, and that are pulled down to close. */
describe("a sheet on a phone", () => {
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

  async function phoneOfAdmin(options: { telegram?: boolean } = {}) {
    const started = await startTestApp({ webDistDir, telegramBotToken: TOKEN });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    if (options.telegram) await page.addInitScript(FAKE_TELEGRAM);
    await page.goto(options.telegram ? `${started.baseUrl}/#tgWebAppData=${encodeURIComponent(signedLaunch(TOKEN, 777))}&tgWebAppVersion=8.0` : started.baseUrl);
    await page.getByLabel("Логин").fill("mudir");
    await page.getByLabel("Пароль").fill("admin password");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();
    return page;
  }

  const sheet = (page: Page) => page.getByRole("dialog", { name: "Новая категория" });
  const backShown = (page: Page) => page.evaluate(() => (window as unknown as { __back: { shown: boolean } }).__back.shown);
  const pressBack = (page: Page) => page.evaluate(() => (window as unknown as { __back: { handlers: Array<() => void> } }).__back.handlers.forEach((handler) => handler()));
  /** A finger put down on `where`, moved down by `by` pixels in steps, and lifted. */
  async function pullDown(where: Locator, by: number) {
    const box = (await where.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(10, box.height / 2);
    const finger = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, clientX: x };
    await where.dispatchEvent("pointerdown", { ...finger, clientY: y });
    for (let step = 1; step <= 4; step++) await where.dispatchEvent("pointermove", { ...finger, clientY: y + (by * step) / 4 });
    await where.dispatchEvent("pointerup", { ...finger, clientY: y + by });
  }

  it("gives Telegram's back button to the window on top, and back to the section under it when the window closes", async () => {
    const page = await phoneOfAdmin({ telegram: true });
    // On a tab of the bar nobody owns the button.
    expect(await backShown(page)).toBe(false);
    // A section opened from «Настройки»: the button is the way back to them.
    await openSection(page, "Категории");
    await expect.poll(() => backShown(page)).toBe(true);

    // A window over the section: the button closes the window, and only the window.
    await page.getByRole("button", { name: "+ Новая" }).click();
    await seeVisible(sheet(page));
    // The sheet ends under Telegram's own buttons (30 + 46 px here), which stay in reach.
    expect((await sheet(page).boundingBox())!.y).toBeGreaterThanOrEqual(76);
    await pressBack(page);
    await seeGone(sheet(page));
    await seeVisible(page.locator('section[aria-label="Категории"]:visible'));
    expect(await backShown(page)).toBe(true);

    // Now the button is the section's again: back to «Настройки», and then it is nobody's.
    await pressBack(page);
    await seeVisible(page.getByRole("navigation", { name: "Все разделы" }));
    await expect.poll(() => backShown(page)).toBe(false);

    // A window closed by its own «×» gives the button back too.
    await openSection(page, "Категории");
    await page.getByRole("button", { name: "+ Новая" }).click();
    await sheet(page).getByRole("button", { name: "Закрыть" }).click();
    await seeGone(sheet(page));
    await pressBack(page);
    await seeVisible(page.getByRole("navigation", { name: "Все разделы" }));
  });

  it("closes when it is pulled down by the grip or the title, 90 px and more, and stays when pulled less", async () => {
    const page = await phoneOfAdmin();
    await openSection(page, "Категории");
    await page.getByRole("button", { name: "+ Новая" }).click();
    await seeVisible(sheet(page));
    const grip = sheet(page).locator("[data-sheet-grab]");
    const title = sheet(page).locator("[data-slot=dialog-title]");

    // A short pull: it comes back, and what was typed is still there.
    await sheet(page).getByRole("textbox", { name: "Название" }).fill("Стоянка");
    await pullDown(grip, 60);
    await expect.poll(() => sheet(page).evaluate((node) => (node as HTMLElement).style.transform)).toBe("");
    expect(await sheet(page).getByRole("textbox", { name: "Название" }).inputValue()).toBe("Стоянка");
    // Pulled by the body of the sheet: nothing, a finger there scrolls and presses.
    await pullDown(sheet(page).getByRole("textbox", { name: "Название" }), 150);
    await seeVisible(sheet(page));

    // A long pull by the grip: gone.
    await pullDown(grip, 120);
    await seeGone(sheet(page));

    // And by the title.
    await page.getByRole("button", { name: "+ Новая" }).click();
    await seeVisible(sheet(page));
    await pullDown(title, 100);
    await seeGone(sheet(page));
  });

  it("is not pulled while its contents are scrolled down", async () => {
    const page = await phoneOfAdmin();
    // A screen so low that the sheet has to scroll.
    await page.setViewportSize({ width: 375, height: 420 });
    await openSection(page, "Категории");
    await page.getByRole("button", { name: "+ Новая" }).click();
    await seeVisible(sheet(page));
    await sheet(page).evaluate((node) => {
      node.scrollTop = 40;
    });
    expect(await sheet(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await pullDown(sheet(page).locator("[data-slot=dialog-title]"), 150);
    await seeVisible(sheet(page));
    // Back at the top it is pulled as ever.
    await sheet(page).evaluate((node) => {
      node.scrollTop = 0;
    });
    await pullDown(sheet(page).locator("[data-slot=dialog-title]"), 150);
    await seeGone(sheet(page));
  });
});
