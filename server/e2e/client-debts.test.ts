import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { importHistory, type HistoryFile } from "../src/admin/history.js";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newLaptop, newPhone, openSection, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The spaces a Russian number is written with are not the one of the keyboard: read as plain ones. */
const plain = (text: string) => text.replace(/[  ]/g, " ");
/** A piece of the screen as one line; the «$» that stands small beside a sum is set a space apart. */
const oneLine = (text: string) => plain(text).replace(/(\d)\$/g, "$1 $").replace(/\s+/g, " ").trim();

/** «Клиенты» of a business that keeps trips: who owes, how much, and who has stopped paying. */
describe("the clients and their debts on the screen", () => {
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

  async function signIn(page: Page, started: TestApp, login: string, password: string) {
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill(login);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();
  }

  const settings = { warehouses: parseWarehouses("andijan,kokand,tashkent"), kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"), clientCodes: "digits" as const };

  /** Seven clients, three trucks in the middle of November 2026 and the payments of that year, as a card file had them. */
  const history: HistoryFile = {
    clientCodes: "digits",
    clients: [
      { code: "1", name: "Улугбек", openingDebtMinor: 2_000_000 },
      { code: "2", name: "Захар", openingDebtMinor: 500_000 },
      { code: "3", name: "Рахим", openingDebtMinor: 90_000 },
      { code: "4", name: "Тимур", openingDebtMinor: 24_700 },
      { code: "5", name: "Марсел" },
      { code: "6", name: "Аброр", openingDebtMinor: 108_403 },
      { code: "7", name: "Саша", openingDebtMinor: 200_000 },
    ],
    trips: [
      { number: 245, arrivalDay: "2026-11-14", sums: [{ code: "1", amountMicro: 3_000_000_000 }] },
      { number: 246, arrivalDay: "2026-11-15", sums: [{ code: "5", amountMicro: 1_142_570_000 }, { code: "2", amountMicro: 500_000_000 }] },
      { number: 247, arrivalDay: "2026-11-16", sums: [{ code: "7", amountMicro: 800_000_000 }, { code: "1", amountMicro: 1_200_000_000 }] },
    ],
    payments: [
      { code: "1", day: "2026-01-05", amountMinor: 100_000, kassa: "moscow" },
      { code: "7", day: "2026-08-14", amountMinor: 50_000, kassa: "moscow" },
      { code: "6", day: "2026-10-17", amountMinor: 10_000, kassa: "andijan" },
      { code: "2", day: "2026-11-10", amountMinor: 30_000, kassa: "moscow" },
      { code: "1", day: "2026-11-16", amountMinor: 600_000, kassa: "tashkent" },
      { code: "4", day: "2026-11-16", amountMinor: 24_700, kassa: "moscow" },
      { code: "5", day: "2026-11-16", amountMinor: 114_400, kassa: "moscow" },
    ],
  };

  /** The business on the 17th of November 2026: how long somebody has not paid is counted up to that day. */
  async function business() {
    const started = await startTestApp({ webDistDir, ...settings });
    app = started;
    started.setNow(new Date("2026-11-17T09:00:00Z"));
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 2 });
    try {
      await importHistory(pool, history, settings);
    } finally {
      await pool.end();
    }
    return started;
  }

  const list = (page: Page) => page.locator("[data-client-debts]:visible");
  /** The lines of the list as they read: the code, the name, the line under it, the debt and its mark. Years are left out of the days. */
  const rows = async (page: Page) => (await list(page).locator("[data-client]").allInnerTexts()).map((text) => oneLine(text).replace(/(\d\d\.\d\d)\.\d\d/g, "$1"));

  it("shows on a phone what all owe, those who owe first, and who has not paid for long; a tap opens the card", async () => {
    const started = await business();
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, started, "mudir", "admin password");
    await openSection(page, "Клиенты");
    await seeVisible(list(page).locator("[data-client]").first());

    // What all owe together, how many of them, and what was paid ahead: a dollar that Марсел gave too much.
    expect(oneLine(await list(page).locator("[data-debts]").innerText())).toBe("Должны всего 26 584 $ 5 должников Предоплаты 1 $ ! Не платят 30+ дней: 3 · 4 184 $");
    // Those who owe, the biggest debt first. Three of them do not pay: the days are marked.
    await seeText(list(page).locator("[data-count]"), /Показано: 5 из 7/i);
    expect(await rows(page)).toEqual([
      "1 Улугбек Оплата 16.11 · рейс 16.11 17 200 $",
      "2 Захар Оплата 10.11 · рейс 15.11 5 200 $",
      "7 Саша Оплата 14.08 · рейс 16.11 2 300 $ 95 дн.",
      "6 Аброр Оплата 17.10 984 $ 31 дн.",
      "3 Рахим Оплат не было 900 $ 320 дн.",
    ]);
    // No buttons in a line, no long explanation over the list, and the control sheet is in «Отчёты» now.
    expect(await list(page).locator("[data-client] button").count()).toBe(0);
    expect(await page.locator('section[aria-label="Клиенты"]:visible .hint').count()).toBe(0);
    expect(await page.locator("[data-control]").count()).toBe(0);
    // Nothing runs off the side of a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Everybody: the one who owes nothing and the one who paid ahead come last.
    await list(page).getByRole("button", { name: "Все", exact: true }).click();
    await seeText(list(page).locator("[data-count]"), /Показано: 7 из 7/i);
    expect((await rows(page)).slice(5)).toEqual(["4 Тимур Оплата 16.11 0 $", "5 Марсел Оплата 16.11 · рейс 15.11 1 $ предоплата"]);

    // The other orders: by the code, and who has not paid longest.
    await list(page).getByRole("button", { name: "Сортировка: По долгу" }).click();
    expect((await rows(page)).map((row) => row.split(" ")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    await list(page).getByRole("button", { name: "Сортировка: По коду" }).click();
    await seeVisible(list(page).getByRole("button", { name: "Сортировка: Кто дольше не платит" }));
    expect((await rows(page)).map((row) => row.split(" ")[0])).toEqual(["3", "7", "6", "2", "1", "4", "5"]);
    await list(page).getByRole("button", { name: "Сортировка: Кто дольше не платит" }).click();

    // The button of those who do not pay is the third choice of the segment.
    await list(page).locator("[data-late]").click();
    expect(await list(page).getByRole("button", { name: "30+ дней", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect((await rows(page)).map((row) => row.split(" ")[0])).toEqual(["7", "6", "3"]);
    // Ninety days and more are marked in red, fewer in amber.
    expect(await list(page).locator('[data-client="7"] [data-days]').getAttribute("class")).toContain("text-destructive");
    expect(await list(page).locator('[data-client="6"] [data-days]').getAttribute("class")).toContain("text-warning");

    // A search, among those the segment keeps; and with nothing found the list says so.
    await list(page).getByRole("searchbox", { name: "Поиск" }).fill("сАш");
    expect(await rows(page)).toEqual(["7 Саша Оплата 14.08 · рейс 16.11 2 300 $ 95 дн."]);
    await list(page).getByRole("searchbox", { name: "Поиск" }).fill("улугбек");
    await seeText(list(page).locator("[data-empty]"), "По запросу «улугбек» клиентов нет.");
    await list(page).getByRole("searchbox", { name: "Поиск" }).fill("");

    // A tap on a line opens the card of the client.
    await list(page).locator('[data-client="7"]').click();
    const card = page.getByRole("dialog", { name: "7 · Саша" });
    await seeText(card, "Рейс № 247");
    // At the top what they owe now, what was charged and paid in all, and when they paid last.
    expect(oneLine(await card.locator("[data-card-top]").innerText())).toBe("Долг сейчас 2 300,00 $ 95 дн. без оплаты Начислено 800,00 $ Оплачено 500,00 $ Посл. оплата 14.08 Изменить Excel");
    // Under it the truck and the payment, the newest first, month by month (the month in capitals), each with the debt after it; and the start.
    expect((await card.locator("[data-feed-month]").allInnerTexts()).map(oneLine)).toEqual([
      "НОЯБРЬ 2026 Рейс № 247 16.11 +800,00 $ долг 2 300,00 $",
      "АВГУСТ 2026 Оплата 14.08 · касса Москва −500,00 $ долг 1 500,00 $",
    ]);
    expect(oneLine(await card.locator("[data-feed-opening]").innerText())).toBe("Долг на начало до первого рейса и первой оплаты 2 000,00 $");
    // The table of five columns is gone, and nothing runs off the side of the phone.
    expect(await card.locator("table").count()).toBe(0);
    expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // The card as a workbook of Excel.
    const [sheet] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Excel" }).click()]);
    expect(sheet.suggestedFilename()).toBe("klient-7.xlsx");
    await card.getByRole("button", { name: "Закрыть" }).click();
    await seeGone(card);
  });

  it("lets the admin change a client from the card, and the owner only look", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "mudir", "admin password");
    await openSection(page, "Клиенты");
    await list(page).locator('[data-client="2"]').click();
    const card = page.getByRole("dialog", { name: "2 · Захар" });
    await card.getByRole("button", { name: "Изменить", exact: true }).click();
    await card.getByRole("textbox", { name: "Имя" }).fill("Захар Каримов");
    await card.getByRole("button", { name: "Сохранить" }).click();
    await seeText(list(page).locator('[data-client="2"]'), "Захар Каримов");

    const other = await newLaptop(browser);
    contexts.push(other.context);
    await signIn(other.page, started, "owner", "long enough pass");
    await openSection(other.page, "Клиенты");
    await list(other.page).locator('[data-client="2"]').click();
    const seen = other.page.getByRole("dialog", { name: "2 · Захар Каримов" });
    await seeText(seen, "Рейс № 246");
    expect(await seen.getByRole("button", { name: "Изменить", exact: true }).count()).toBe(0);
    expect(await other.page.getByRole("button", { name: "+ Новый", exact: true }).count()).toBe(0);
  });
});
