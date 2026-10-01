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
