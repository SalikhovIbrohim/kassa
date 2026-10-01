import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeVisible } from "./browser.js";
import { withRate } from "../test/helpers/entries.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

type Entry = Record<string, unknown>;

/** The viewer's totals of a period, in a real browser against the real server. */
describe("the totals of a period, on the viewer's screen", () => {
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

  const income = (overrides: Entry = {}): Entry => withRate({ id: randomUUID(), type: "income", amountMinor: 100_000, currency: "RUB", clientCode: "K17", ...overrides });
  const expense = (overrides: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides });

  /** What a place on the screen says, with every kind of space made an ordinary one. */
  const said = async (locator: Locator) => (await locator.innerText({ timeout: 1000 }).catch(() => "")).replace(/[\s  ]+/g, " ").trim();
  const sees = (locator: Locator, expected: string) => expect.poll(() => said(locator), { timeout: 20_000, interval: 100 }).toBe(expected);

  /**
   * A cash desk with books for yesterday and today, a cashier and a viewer, and the viewer's phone open on the
   * journal. Opening balances: 10 000,00 RUB and 50,00 USD.
   */
  async function desk(options: { signInAs?: "owner" | "ivan"; width?: number } = {}) {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "10000");
    await started.admin.setOpeningBalance("USD", "50");
    const ivan = await loginAs(started, "ivan", "correct horse");

    const record = async (body: Entry, daysAgo = 0) => {
      // The clock of the server is moved to noon in Moscow (09:00 UTC) of that Moscow day for the moment of writing.
      const moscowToday = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const noon = new Date(`${moscowToday}T09:00:00Z`);
      started.setNow(new Date(noon.getTime() - daysAgo * 24 * 60 * 60 * 1000));
      const response = await postJson(started, "/api/operations", body, ivan);
      expect(response.status, await response.clone().text()).toBe(201);
      started.setNow(new Date());
      return body.id as string;
    };

    // Yesterday: 1 000,00 in. Today: the rest.
    await record(income({ amountMinor: 100_000, clientCode: "K1" }), 1);
    await record(income({ amountMinor: 300_000, clientCode: "K2" }));
    await record(income({ amountMinor: 100_000, clientCode: "K3" }));
    await record(income({ amountMinor: 12_050, currency: "USD", clientCode: "K4" }));
    await record(expense({ amountMinor: 50_000, category: "fuel_road" }));
    await record(expense({ amountMinor: 120_000, category: "salaries" }));
    await record(expense({ amountMinor: 20_000, category: "client_refund", clientCode: "K2" }));
    await record(expense({ amountMinor: 40_000, category: "owner_handover", recipient: "Азамат" }));
    const mistake = await record(expense({ amountMinor: 999_00, category: "other" }));
    const removal = await fetch(`${started.baseUrl}/api/operations/${mistake}`, { method: "DELETE", headers: { cookie: ivan } });
    expect(removal.status).toBe(200);

    const phone = await newPhone(browser);
    context = phone.context;
    const page = phone.page;
    if (options.width) await page.setViewportSize({ width: options.width, height: 844 });
    await page.goto(started.baseUrl);
    const who = options.signInAs ?? "owner";
    await page.getByLabel("Логин").fill(who);
    await page.getByLabel("Пароль").fill(who === "owner" ? "long enough pass" : "correct horse");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    return { started, page, ivan, record };
  }

  /** The journal stays alive, hidden, under the same names for its own date fields: ask in the totals. */
  const totalsRegion = (page: Page) => page.getByRole("region", { name: "Итоги", exact: true });
  const openTotals = (page: Page) => page.getByRole("button", { name: "Итоги", exact: true }).click();
  const card = (page: Page, name: "Рубли" | "Доллары") => page.getByRole("region", { name, exact: true }).filter({ has: page.locator("dl") });
  const total = (page: Page, name: "Рубли" | "Доллары", what: string) => card(page, name).locator(`[data-total="${what}"]`);

  it("shows today's totals for each currency, with the expense by category, the refund and the handover on their own lines", async () => {
    const { page } = await desk();

    await openTotals(page);

    await sees(total(page, "Рубли", "opening"), "11 000,00 ₽");
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");
    await sees(total(page, "Рубли", "expense"), "−1 900,00 ₽");
    await sees(card(page, "Рубли").locator('[data-category="fuel_road"]'), "−500,00 ₽");
    await sees(card(page, "Рубли").locator('[data-category="salaries"]'), "−1 200,00 ₽");
    await sees(card(page, "Рубли").locator('[data-category="client_refund"]'), "−200,00 ₽");
    await sees(total(page, "Рубли", "handover"), "−400,00 ₽");
    await sees(total(page, "Рубли", "closing"), "12 700,00 ₽");
    // A category with nothing in it is not listed; the deleted entry is nowhere.
    expect(await card(page, "Рубли").locator('[data-category="other"]').count()).toBe(0);
    expect(await said(card(page, "Рубли"))).not.toContain("999");
    // The other currency, on its own.
    await sees(total(page, "Доллары", "opening"), "50,00 $");
    await sees(total(page, "Доллары", "income"), "+120,50 $");
    await sees(total(page, "Доллары", "closing"), "170,50 $");
    // The period is said in words.
    await sees(page.getByRole("status").filter({ hasText: "За " }), `За ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date())}`);
  }, 90_000);

  it("changes the period with the quick buttons: yesterday, seven days, this month", async () => {
    const { page } = await desk();
    await openTotals(page);
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");

    await page.getByRole("button", { name: "Вчера", exact: true }).click();
    await sees(total(page, "Рубли", "income"), "+1 000,00 ₽");
    await sees(total(page, "Рубли", "opening"), "10 000,00 ₽");
    await sees(total(page, "Рубли", "closing"), "11 000,00 ₽");
    expect(await page.getByRole("button", { name: "Вчера", exact: true }).getAttribute("aria-pressed")).toBe("true");

    await page.getByRole("button", { name: "7 дней", exact: true }).click();
    await sees(total(page, "Рубли", "income"), "+5 000,00 ₽");
    await sees(total(page, "Рубли", "closing"), "12 700,00 ₽");
  }, 90_000);

  it("takes two dates, and says what is wrong with a start after the end instead of asking the server", async () => {
    const { page } = await desk();
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/summary")) asked.push(request.url());
    });
    await openTotals(page);
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");
    const before = asked.length;

    await totalsRegion(page).getByLabel("Период: по").fill("2020-01-01");

    await seeVisible(page.getByRole("alert").filter({ hasText: "Начало периода позже конца." }));
    expect(asked.length).toBe(before);

    // A period in the past, before anything was recorded: the opening balance is all there is.
    await totalsRegion(page).getByLabel("Период: с").fill("2020-01-01");
    await sees(total(page, "Рубли", "income"), "0,00 ₽");
    await sees(total(page, "Рубли", "closing"), "10 000,00 ₽");
    expect(await page.getByRole("alert").count()).toBe(0);
  }, 90_000);

  it("asks again when the viewer comes back to it or presses Update, and shows what was entered meanwhile", async () => {
    const { page, record } = await desk();
    await openTotals(page);
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");

    await record(income({ amountMinor: 50_000, clientCode: "K9" }));
    await page.getByRole("button", { name: "Журнал", exact: true }).click();
    await page.getByRole("button", { name: "Итоги", exact: true }).click();

    await sees(total(page, "Рубли", "income"), "+4 500,00 ₽");

    await record(income({ amountMinor: 20_000, clientCode: "K10" }));
    await page.getByRole("region", { name: "Итоги" }).getByRole("button", { name: "Обновить" }).click();

    await sees(total(page, "Рубли", "income"), "+4 700,00 ₽");
  }, 90_000);

  it("keeps the period that was chosen while the viewer looks at the journal, and the filters of the journal in turn", async () => {
    const { page } = await desk();
    await openTotals(page);
    await page.getByRole("button", { name: "Вчера", exact: true }).click();
    await sees(total(page, "Рубли", "income"), "+1 000,00 ₽");

    await page.getByRole("button", { name: "Журнал", exact: true }).click();
    await page.getByRole("button", { name: "Итоги", exact: true }).click();

    expect(await page.getByRole("button", { name: "Вчера", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await sees(total(page, "Рубли", "income"), "+1 000,00 ₽");
  }, 90_000);

  it("is not offered to a cashier", async () => {
    const { page } = await desk({ signInAs: "ivan" });

    expect(await page.getByRole("button", { name: "Итоги", exact: true }).count()).toBe(0);
  }, 90_000);

  it("fits a phone: nothing is wider than the screen", async () => {
    const { page } = await desk({ width: 320 });
    await openTotals(page);
    await sees(total(page, "Рубли", "closing"), "12 700,00 ₽");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    expect(overflow).toBeLessThanOrEqual(0);
  }, 90_000);
});
