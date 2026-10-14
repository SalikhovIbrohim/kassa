import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { expect } from "vitest";

/**
 * Chromium for the tests: the one named in CHROMIUM_PATH, else the one Playwright installed for its
 * own version (`npx playwright install chromium`), else any Chromium in PLAYWRIGHT_BROWSERS_PATH.
 */
function findChromium(): string {
  const candidates: string[] = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  candidates.push(chromium.executablePath());
  const folder = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (folder && existsSync(folder)) {
    for (const name of readdirSync(folder).sort().reverse()) {
      if (name.startsWith("chromium-")) candidates.push(join(folder, name, "chrome-linux", "chrome"));
    }
  }
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    throw new Error("No Chromium found. Run `npx playwright install chromium`, or set CHROMIUM_PATH.");
  }
  return found;
}

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ executablePath: findChromium() });
}

/** A phone: a narrow touch screen, with its own storage, cookies and service worker. */
export async function newPhone(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ru-RU",
    timezoneId: "Asia/Tashkent",
  });
  const page = await context.newPage();
  return { context, page };
}

/** A laptop: a wide screen with a mouse, where «Управление» has its menu on the left. */
export async function newLaptop(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "ru-RU", timezoneId: "Asia/Tashkent" });
  const page = await context.newPage();
  return { context, page };
}

/** Picks an item of the cash desk's menu ☰ (the journal, the admin's «Управление»). */
export async function cashMenu(page: Page, label: string): Promise<void> {
  await page.locator("main.page").getByRole("button", { name: "Меню", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
}

/** Leaves from the cash desk: «Выйти» is in its menu ☰. */
export async function leaveCashDesk(page: Page): Promise<void> {
  await cashMenu(page, "Выйти");
}

/** Opens a section of «Управление» from its menu: on a phone the menu first comes out from behind ☰. */
export async function openSection(page: Page, label: string): Promise<void> {
  const burger = page.getByRole("button", { name: "Меню", exact: true });
  if (await burger.isVisible()) await burger.click();
  await page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: label, exact: true }).click();
}

/** The admin goes from «Управление» back to the cash desk (the switch at the top of the menu). */
export async function backToCashDesk(page: Page): Promise<void> {
  const burger = page.getByRole("button", { name: "Меню", exact: true });
  if (await burger.isVisible()) await burger.click();
  await page.getByRole("group", { name: "Режим" }).getByRole("button", { name: "Касса", exact: true }).click();
}

const WAIT = { timeout: 20_000, interval: 100 };

const asPattern = (expected: string | RegExp) =>
  typeof expected === "string" ? new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : expected;

/** Waits until the text of the element contains `expected` (or fails after 20 seconds). */
export function seeText(locator: Locator, expected: string | RegExp) {
  return expect.poll(() => locator.innerText({ timeout: 500 }).catch(() => ""), WAIT).toMatch(asPattern(expected));
}

/** Waits until the element is on the screen. */
export function seeVisible(locator: Locator) {
  return expect.poll(() => locator.isVisible().catch(() => false), WAIT).toBe(true);
}

/** Waits until the field has this value. */
export function seeValue(locator: Locator, expected: string) {
  return expect.poll(() => locator.inputValue({ timeout: 500 }).catch(() => undefined), WAIT).toBe(expected);
}

/** Waits until nothing matches the locator any more. */
export function seeGone(locator: Locator) {
  return expect.poll(() => locator.count(), WAIT).toBe(0);
}
