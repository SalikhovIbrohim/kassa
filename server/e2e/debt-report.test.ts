import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { importHistory, type HistoryFile } from "../src/admin/history.js";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newLaptop, newPhone, openSection, seeGone, seeText, seeValue, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The spaces a Russian number is written with are not the one of the keyboard: read as plain ones. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

/** «Отчёты»: the debts of the clients for a day, in the four pictures the business sends on every evening. */
describe("the report on the debts on the screen", () => {
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
      { code: "5", day: "2026-11-16", amountMinor: 114_300, kassa: "moscow" },
    ],
  };

  async function business() {
    const started = await startTestApp({ webDistDir, ...settings });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "sklad", password: "warehouse pass", role: "warehouse", displayName: "Завсклад" });
    const pool = new pg.Pool({ connectionString: started.databaseUrl, max: 2 });
    try {
      await importHistory(pool, history, settings);
    } finally {
      await pool.end();
    }
    return started;
  }

  const report = (page: Page) => page.locator("[data-debt-report]:visible");
  const block = (page: Page, name: string) => report(page).locator(`[data-block="${name}"]`);
  /** A piece of the screen as one line; the «$» that stands small beside a sum is set a space apart. */
  const oneLine = (text: string) => plain(text).replace(/(\d)\$/g, "$1 $").replace(/\s+/g, " ").trim();
  const lines = async (scope: Locator, what = "[data-code]") => (await scope.locator(what).allInnerTexts()).map(oneLine);
  /** The report of a day is on the screen, the whole of it. */
  async function showDay(page: Page, day: string) {
    await report(page).locator("input[name=day]").fill(day);
    await seeValue(report(page).locator("input[name=day]"), day);
    await report(page).and(page.locator('[aria-busy="false"]')).waitFor();
    await seeVisible(block(page, "control").locator("[data-month]").first());
  }
  /** Presses the button of the pictures and gathers the files it gives. */
  async function pictures(page: Page, many: number, button: string) {
    const saved: Array<{ name: string; width: number; size: number }> = [];
    const done: Promise<void>[] = [];
    const listen = (download: import("playwright-core").Download) => {
      done.push(
        (async () => {
          const bytes = await readFile(await download.path());
          saved.push({ name: download.suggestedFilename(), width: bytes.readUInt32BE(16), size: bytes.length });
        })(),
      );
    };
    page.on("download", listen);
    await report(page).getByRole("button", { name: button }).click();
    await expect.poll(() => done.length, { timeout: 30_000 }).toBe(many);
    await Promise.all(done);
    page.off("download", listen);
    return saved.sort((one, other) => one.name.localeCompare(other.name));
  }

  it("shows a cashier the day in cards: four numbers, who paid, who was charged, who owes most and who does not pay", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "ivan", "correct horse");
    await openSection(page, "Отчёты");
    await showDay(page, "2026-11-16");

    // How the debt moved: what it was, what it is, what the truck added, what was paid.
    expect(await lines(report(page), "[data-tile]")).toEqual([
      "Долг на 15.11 31 974 $",
      "Долг на 16.11 26 584 $ снизился на 5 390 $",
      "Начислено +2 000 $ рейс 247 (16.11), 2 клиента",
      "Оплачено −7 390 $ 3 плательщика",
    ]);
    // Who paid, the biggest first, with the desk that took it when it was not the main one; who was charged, with the truck.
    await seeText(block(page, "paid").locator("h3"), /Кто оплатил\s*7.390.\$/);
    expect(await lines(block(page, "paid"))).toEqual(["Улугбек 1 Ташкент 6 000", "Марсел 5 1 143", "Тимур 4 247"]);
    expect(await lines(block(page, "charged"))).toEqual(["Улугбек 1 рейс 247 1 200", "Саша 7 рейс 247 800"]);
    // Who owes most, with the place and what the period changed.
    await seeText(block(page, "top").locator("h3"), /Должники\s*5 всего/);
    expect(await lines(block(page, "top"))).toEqual(["1 Улугбек 1 17 200 за период −4 800 $", "2 Захар 2 5 200", "3 Саша 7 2 300 за период +800 $", "4 Аброр 6 984", "5 Рахим 3 900"]);
    // Who has not paid for long: the days, and the last truck (in red when it came in this period).
    await seeText(block(page, "overdue").locator("h3"), /Долго не платят\s*3 · 4.184.\$/);
    expect(await lines(block(page, "overdue"))).toEqual(["Саша 7 2 300 94 дн. без оплаты посл. рейс 16.11", "Аброр 6 984 30 дн. без оплаты рейсов нет", "Рахим 3 900 319 дн. без оплаты рейсов нет"]);
    await seeVisible(block(page, "overdue").locator('[data-code="7"] .text-destructive').last());
    // The control sheet came here from «Клиенты»: every month of the year up to the day.
    expect(await block(page, "control").locator("[data-month]").count()).toBe(11);
    expect(oneLine(await block(page, "control").locator('[data-month="2026-11"]').innerText())).toBe("Ноябрь 27 631,03 6 642,57 7 690,00 26 583,60");
    await seeText(block(page, "control"), "Ноябрь — по 16.11 включительно.");

    // A tap on a client opens the card, for a cashier too.
    await block(page, "paid").locator('[data-code="1"]').click();
    const card = page.getByRole("dialog", { name: "1 · Улугбек" });
    await seeText(card, "Рейс № 247");
    await seeText(card, /Долг сейчас\s*17.200,00/);
    await card.getByRole("button", { name: "Закрыть" }).click();
    await seeGone(card);

    // The pictures for a chat are made only when asked for: nothing of them is on the page before, nothing after.
    expect(await page.locator("[data-pictures]").count()).toBe(0);
    const saved = await pictures(page, 4, "Скачать 4 картинки");
    expect(saved.map((file) => file.name)).toEqual(["dolgi-2026-11-16-1-izmenenie-dolga.png", "dolgi-2026-11-16-2-top-30.png", "dolgi-2026-11-16-3-dolgo-ne-platyat.png", "dolgi-2026-11-16-4-kontrol.png"]);
    // Each 760 px wide and twice as dense, whatever the window is, and not an empty one.
    for (const file of saved) {
      expect(file.width, file.name).toBe(1520);
      expect(file.size, file.name).toBeGreaterThan(20_000);
    }
    await seeGone(page.locator("[data-pictures]"));

    // The sheet of Excel.
    const [sheet] = await Promise.all([page.waitForEvent("download"), report(page).getByRole("button", { name: "Excel: не платят 7+ дней" }).click()]);
    expect(sheet.suggestedFilename()).toBe("ne-platyat-7-dney-2026-11-16.xlsx");
    expect((await readFile(await sheet.path())).subarray(0, 2).toString()).toBe("PK");
  });

  it("compares the day with a week or a month back, and steps from day to day", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "ivan", "correct horse");
    await openSection(page, "Отчёты");
    await showDay(page, "2026-11-16");
    await report(page).getByRole("button", { name: "За 7 дней" }).click();
    await expect.poll(async () => (await lines(report(page), "[data-tile]"))[0]).toBe("Долг на 09.11 27 631 $");
    expect((await lines(report(page), "[data-tile]")).slice(2)).toEqual(["Начислено +6 643 $ рейсы 245 (14.11), 246 (15.11), 247 (16.11); 4 клиента", "Оплачено −7 690 $ 4 плательщика"]);
    // Улугбек: two trucks in the week.
    expect((await lines(block(page, "charged")))[0]).toBe("Улугбек 1 рейс 245, 247 4 200");

    // A step back keeps the week; «За день» is the 15th against the 14th.
    await report(page).getByRole("button", { name: "Предыдущий день" }).click();
    await seeValue(report(page).locator("input[name=day]"), "2026-11-15");
    await expect.poll(async () => (await lines(report(page), "[data-tile]"))[0]).toBe("Долг на 08.11 27 631 $");
    await report(page).getByRole("button", { name: "За день" }).click();
    await expect.poll(async () => (await lines(report(page), "[data-tile]"))[0]).toBe("Долг на 14.11 30 331 $");
    await seeText(block(page, "paid"), "За этот период оплат не было.");
    expect(await lines(block(page, "charged"))).toEqual(["Марсел 5 рейс 246 1 143", "Захар 2 рейс 246 500"]);
    // Today has no day after it.
    expect(await report(page).getByRole("button", { name: "Следующий день" }).isDisabled()).toBe(false);
  });

  it("gives a fifth picture on the last day of a month", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "ivan", "correct horse");
    await openSection(page, "Отчёты");
    await showDay(page, "2026-11-16");
    await seeVisible(report(page).getByRole("button", { name: "Скачать 4 картинки" }));
    await showDay(page, "2026-10-31");
    const saved = await pictures(page, 5, "Скачать 5 картинок");
    expect(saved.map((file) => file.name)).toEqual([
      "dolgi-2026-10-31-1-izmenenie-dolga.png",
      "dolgi-2026-10-31-2-top-30.png",
      "dolgi-2026-10-31-3-dolgo-ne-platyat.png",
      "dolgi-2026-10-31-4-kontrol.png",
      "dolgi-2026-10-31-5-dinamika.png",
    ]);
  });

  it("fits a phone without the page running sideways, and is nobody's where there are no trips or no cash", async () => {
    const started = await business();
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await phone.page.setViewportSize({ width: 375, height: 812 });
    await signIn(phone.page, started, "ivan", "correct horse");
    await openSection(phone.page, "Отчёты");
    await showDay(phone.page, "2026-11-16");
    await seeText(block(phone.page, "overdue").locator("h3"), /3 · 4.184/);
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The pictures from a phone are the same pictures: as wide as from a computer.
    const saved = await pictures(phone.page, 4, "Скачать 4 картинки");
    expect(saved.map((file) => file.width)).toEqual([1520, 1520, 1520, 1520]);

    // The keeper of a warehouse has no such section.
    const keeper = await newLaptop(browser);
    contexts.push(keeper.context);
    await signIn(keeper.page, started, "sklad", "warehouse pass");
    const menu = keeper.page.getByRole("navigation", { name: "Разделы" });
    await seeVisible(menu.getByRole("button", { name: "Сборные грузы", exact: true }));
    await seeGone(menu.getByRole("button", { name: "Отчёты", exact: true }));

    // A business that keeps no trips has no debts to report. (The screens of the first business are closed before its
    // server is: a page that has just signed in is still asking it things, and a server asked while it stops can wait
    // for an answer that never comes.)
    for (const context of contexts.splice(0)) await context.close();
    await app!.close();
    const plainApp = await startTestApp({ webDistDir });
    app = plainApp;
    await plainApp.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const cashier = await newLaptop(browser);
    contexts.push(cashier.context);
    await signIn(cashier.page, plainApp, "ivan", "correct horse");
    const plainMenu = cashier.page.getByRole("navigation", { name: "Разделы" });
    await seeVisible(plainMenu.getByRole("button", { name: "Журнал", exact: true }));
    await seeGone(plainMenu.getByRole("button", { name: "Отчёты", exact: true }));
  });
});
