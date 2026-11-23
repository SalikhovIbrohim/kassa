import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newPhone, seeGone, seeText, seeVisible, openSection, selectField } from "./browser.js";
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
    await page.locator("[data-signed-in]:visible").first().waitFor();
    return { started, page, ivan, record };
  }

  /** The journal stays alive, hidden, under the same names for its own date fields: ask in the totals. */
  const totalsRegion = (page: Page) => page.getByRole("region", { name: "Итоги", exact: true });
  const openTotals = (page: Page) => openSection(page, "Итоги");
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

    // The two dates are chosen in a sheet that the calendar of the page's name opens, and asked for on «Показать».
    await page.getByRole("button", { name: "Период" }).click();
    const sheet = page.getByRole("dialog", { name: "Период" });
    await sheet.getByLabel("Период: по").fill("2020-01-01");

    await seeVisible(sheet.getByRole("alert").filter({ hasText: "Начало периода позже конца." }));
    expect(await sheet.getByRole("button", { name: "Показать" }).isDisabled()).toBe(true);
    expect(asked.length).toBe(before);

    // A period in the past, before anything was recorded: the opening balance is all there is.
    await sheet.getByLabel("Период: с").fill("2020-01-01");
    await sheet.getByRole("button", { name: "Показать" }).click();
    await sees(total(page, "Рубли", "income"), "0,00 ₽");
    await sees(total(page, "Рубли", "closing"), "10 000,00 ₽");
    expect(await page.getByRole("alert").count()).toBe(0);
    // A period of the person's own is said as a mark under the quick choices; its cross takes it off, back to today.
    const mark = totalsRegion(page).locator('[data-chip="period"]');
    await seeText(mark, "01.01.2020");
    await mark.getByRole("button", { name: "Убрать свой период" }).click();
    await seeGone(mark);
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");
    // The four quick choices stand in one row.
    const tops = await totalsRegion(page).locator("[data-presets] button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await totalsRegion(page).locator("[data-presets] button").allInnerTexts()).toEqual(["Сегодня", "Вчера", "7 дней", "Месяц"]);
  }, 90_000);

  it("asks again when the viewer comes back to it or presses Update, and shows what was entered meanwhile", async () => {
    const { page, record } = await desk();
    await openTotals(page);
    await sees(total(page, "Рубли", "income"), "+4 000,00 ₽");

    await record(income({ amountMinor: 50_000, clientCode: "K9" }));
    await openSection(page, "Журнал");
    await openSection(page, "Итоги");

    await sees(total(page, "Рубли", "income"), "+4 500,00 ₽");

    await record(income({ amountMinor: 20_000, clientCode: "K10" }));
    // «Обновить» is a round button in the row of the page's name.
    await page.getByRole("button", { name: "Обновить" }).click();

    await sees(total(page, "Рубли", "income"), "+4 700,00 ₽");
  }, 90_000);

  it("keeps the period that was chosen while the viewer looks at the journal, and the filters of the journal in turn", async () => {
    const { page } = await desk();
    await openTotals(page);
    await page.getByRole("button", { name: "Вчера", exact: true }).click();
    await sees(total(page, "Рубли", "income"), "+1 000,00 ₽");

    await openSection(page, "Журнал");
    await openSection(page, "Итоги");

    expect(await page.getByRole("button", { name: "Вчера", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await sees(total(page, "Рубли", "income"), "+1 000,00 ₽");
  }, 90_000);

  it("filters the journal in a sheet: a row of periods on the page, the filters asked for on «Показать», each one a mark that takes it off", async () => {
    const { page } = await desk();
    await openSection(page, "Журнал");
    // (Found by its tag and not by its role: under an open sheet the page is out of the reach of roles.)
    const journal = page.locator('section[aria-label="Журнал"]');
    const rows = journal.locator("tbody tr.income, tbody tr.expense");
    // Today: three incomes and four expenses (the deleted one is hidden).
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(7);
    // The quick choices of a period stand in one row, and the folded form of filters is gone.
    expect(await journal.locator("[data-presets] button").allInnerTexts()).toEqual(["Сегодня", "Вчера", "7 дней", "Месяц"]);
    const tops = await journal.locator("[data-presets] button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await journal.locator("details").count()).toBe(0);
    await journal.getByRole("button", { name: "Вчера", exact: true }).click();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(1);
    await journal.getByRole("button", { name: "Сегодня", exact: true }).click();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(7);

    // The funnel of the page's name opens the sheet. Nothing is asked for while its fields are being changed.
    const funnel = page.getByRole("button", { name: "Фильтры" });
    expect(await funnel.locator("[data-count]").count()).toBe(0);
    await funnel.click();
    const sheet = page.getByRole("dialog", { name: "Фильтры" });
    await choose(selectField(sheet, "type"), "income");
    await choose(selectField(sheet, "currency"), "USD");
    expect(await rows.count()).toBe(7);
    await sheet.getByRole("button", { name: "Показать" }).click();
    await seeGone(sheet);
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(1);

    // The filters that are on: counted on the funnel, and each a mark with a cross under the row of periods.
    await seeText(funnel.locator("[data-count]"), "2");
    expect(await journal.locator("[data-chip]").allInnerTexts()).toEqual(["Приход", "Доллары"]);
    await seeVisible(journal.getByRole("button", { name: "Сбросить все" }));
    await journal.getByRole("button", { name: "Убрать фильтр: Доллары" }).click();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(3);
    // One mark left: nothing to take off all at once.
    expect(await journal.getByRole("button", { name: "Сбросить все" }).count()).toBe(0);

    // The sheet opens with what is on; «Сбросить» in it clears its fields, and still nothing is asked for until «Показать».
    await funnel.click();
    await seeText(selectField(sheet, "type"), "Приход");
    await choose(selectField(sheet, "type"), "expense");
    await choose(selectField(sheet, "currency"), "USD");
    await sheet.getByRole("button", { name: "Показать" }).click();
    // Nothing is like that: the list says so in the middle, with the way out.
    const empty = journal.locator("[data-empty]");
    await seeText(empty, "По этим условиям записей нет.");
    await empty.getByRole("button", { name: "Сбросить фильтры" }).click();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(7);
    expect(await journal.locator("[data-chip]").count()).toBe(0);

    // A period of the person's own is a mark too; closing the sheet by its cross asks for nothing.
    await funnel.click();
    await sheet.getByLabel("Период: с").fill("2020-01-01");
    await sheet.getByRole("button", { name: "Закрыть" }).click();
    expect(await journal.locator("[data-chip]").count()).toBe(0);
    await funnel.click();
    await sheet.getByLabel("Период: с").fill("2020-01-01");
    await sheet.getByRole("button", { name: "Показать" }).click();
    await seeText(journal.locator('[data-chip="period"]'), /01\.01\.2020 – /);
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }, 90_000);

  it("is not offered to a cashier", async () => {
    const { page } = await desk({ signInAs: "ivan" });

    await seeVisible(page.getByRole("tab", { name: "Приход", exact: true }));
    expect(await page.getByRole("navigation", { name: "Разделы" }).count()).toBe(0);
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
