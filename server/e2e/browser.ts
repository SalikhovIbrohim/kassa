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

/** A laptop: a wide screen with a mouse, with the menu of sections on the left. */
export async function newLaptop(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "ru-RU", timezoneId: "Asia/Tashkent" });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Opens a section. A computer has every section in the menu on the left; a phone has four on the tab bar and the others
 * in «Настройки» (the list «Все разделы»).
 */
export async function openSection(page: Page, label: string): Promise<void> {
  await page.locator("[data-signed-in]:visible").first().waitFor();
  const menu = page.getByRole("navigation", { name: "Разделы" });
  if (await menu.isVisible()) {
    await menu.getByRole("button", { name: label, exact: true }).click();
    return;
  }
  const bar = page.getByRole("tablist", { name: "Основные разделы" });
  const tab = bar.getByRole("tab", { name: label, exact: true });
  if ((await tab.count()) > 0) {
    await tab.click();
    return;
  }
  await bar.getByRole("tab", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Все разделы" }).getByRole("button", { name: label, exact: true }).click();
}

/** Leaves: «Выйти» is in the header on a computer, in «Настройки» on a phone. */
export async function leaveCashDesk(page: Page): Promise<void> {
  await page.locator("[data-signed-in]:visible").first().waitFor();
  const settings = page.getByRole("tablist", { name: "Основные разделы" }).getByRole("tab", { name: "Настройки", exact: true });
  if (await settings.isVisible()) await settings.click();
  await page.getByRole("button", { name: "Выйти", exact: true }).locator("visible=true").first().click();
}

/** Back to the forms of the cash desk. */
export async function backToCashDesk(page: Page): Promise<void> {
  await openSection(page, "Приход");
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

/** A drop-down list drawn by the page (web/src/components/ui/select.tsx), found by the name of its field. */
export const selectField = (scope: Page | Locator, name: string) => scope.locator(`[data-slot=select-trigger][data-name=${name}]:visible`).first();

/** Opens a drop-down list drawn by the page and chooses a line: by its value, or by its text. */
export async function choose(trigger: Locator, option: string | { label: string }) {
  await trigger.click();
  const page = trigger.page();
  const item = typeof option === "string" ? page.locator(`[role=option][data-value="${option}"]`) : page.getByRole("option", { name: option.label, exact: true });
  await item.click();
  await page.getByRole("listbox").waitFor({ state: "hidden" });
}

/** The lines a drop-down list drawn by the page offers, read by opening it and closing it again. */
export async function optionsOf(trigger: Locator): Promise<string[]> {
  await trigger.click();
  const page = trigger.page();
  await page.getByRole("option").first().waitFor();
  const texts = await page.getByRole("option").evaluateAll((items) => items.map((item) => item.firstElementChild?.textContent ?? ""));
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  return texts;
}
