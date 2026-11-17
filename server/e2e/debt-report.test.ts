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
  const picture = (page: Page, key: string) => report(page).locator(`[data-picture="${key}"]`);
  /** The report of a day is on the screen, the whole of it. */
  async function showDay(page: Page, day: string) {
    await report(page).locator("input[name=day]").fill(day);
    await seeValue(report(page).locator("input[name=day]"), day);
    await report(page).and(page.locator('[aria-busy="false"]')).waitFor();
    await seeVisible(picture(page, "control").locator("[data-month]").first());
  }
  /** Waits until the text of the element, its spaces read as plain ones, contains `expected`. */
  const seePlain = (locator: Locator, expected: string) => expect.poll(async () => plain(await locator.innerText({ timeout: 500 }).catch(() => "")), { timeout: 20_000 }).toContain(expected);
  const tiles = async (scope: Locator) => (await scope.locator("[data-tile]").allInnerTexts()).map((text) => plain(text).split("\n").map((line) => line.trim()).filter(Boolean));

  it("shows a cashier the four pictures of a day, and gives each out as a PNG and the long unpaid as a workbook", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "ivan", "correct horse");
    await openSection(page, "Отчёты");
    await showDay(page, "2026-11-16");
    // Compared with the day before, unless another is chosen.
    await seeValue(report(page).locator("input[name=since]"), "2026-11-15");

    // How the debt moved: what it was, what the truck added, what was paid and where, what it is.
    const movement = picture(page, "movement");
    expect(await tiles(movement)).toEqual([
      ["Долг на 15.11", "$31 974"],
      ["Начислено", "+ 2 000", "рейс 247 (16.11), 2 клиента"],
      ["Оплачено", "− 7 390", "3 клиента, из них Ташкент 6 000"],
      ["Долг на 16.11", "$26 584", "−5 390 за день"],
    ]);
    const paid = movement.locator('[data-list="paid"]');
    await seeText(paid, "Кто оплатил 16.11");
    expect((await paid.locator("[data-code]").allInnerTexts()).map((text) => plain(text).replace(/\s+/g, " ").trim())).toEqual(["Улугбек (1) Ташкент 6 000", "Марсел (5) 1 143", "Тимур (4) 247"]);
    const charged = movement.locator('[data-list="charged"]');
    await seeText(charged, "Кому начислено 16.11");
    expect((await charged.locator("[data-code]").allInnerTexts()).map((text) => plain(text).replace(/\s+/g, " ").trim())).toEqual(["Улугбек (1) 247 1 200", "Саша (7) 247 800"]);
    const note = plain(await movement.locator("[data-note]").innerText());
    // Nobody looked on the 15th, so nothing was kept of it.
    expect(note).toContain("Закрытие 15.11 не сохранено — правки задним числом не проверялись.");
    expect(note).toContain("Оплатили рейс 246 на следующий день: Марсел (5) 1 143.");
    expect(note).toContain("Закрыли долг: Тимур (4), Марсел (5).");

    // Who owes most: five of them here, each with the change of the day and the last payment.
    const top = picture(page, "top");
    expect((await top.locator("tbody tr").allInnerTexts()).map((text) => plain(text).replace(/\s+/g, " ").trim())).toEqual([
      "1 Улугбек (1) 17 200 −4 800 16.11",
      "2 Захар (2) 5 200 — 10.11",
      "3 Саша (7) 2 300 +800 14.08",
      "4 Аброр (6) 984 — 17.10",
      "5 Рахим (3) 900 — —",
    ]);
    // Thirty days and more without a payment: the day is in red.
    await seeVisible(top.locator('tr[data-code="6"] [data-last-paid].dr-bad'));
    await seeVisible(top.locator('tr[data-code="2"] [data-last-paid].dr-muted'));
    await seeText(top.locator("[data-note]"), /Всего должников 5, их долг 26.584.\$\./);

    // Who has not paid for long: three, one of them new, one with cargo on the truck of this day.
    const overdue = picture(page, "overdue");
    expect(await tiles(overdue)).toEqual([
      ["Не платят 30+ дней", "3 клиента"],
      ["Их долг", "$4 184"],
      ["Из них 90+ дней или ни разу в 2026", "2 клиента"],
    ]);
    expect((await overdue.locator("tbody tr").allInnerTexts()).map((text) => plain(text).replace(/\s+/g, " ").trim())).toEqual([
      "Саша (7) 2 300 14.08.26 94 дн. 16.11.26",
      "Аброр (6) новый 984 17.10.26 30 дн. —",
      "Рахим (3) 900 в 2026 нет 319 дн. —",
    ]);
    await seeVisible(overdue.locator('tr[data-code="7"] [data-last-trip].dr-bad'));
    await seeVisible(overdue.locator('tr[data-code="7"] .dr-plate.dr-long'));

    // The control sheet: every month of the year up to the day.
    const control = picture(page, "control");
    expect(await control.locator("[data-month]").count()).toBe(11);
    expect(plain(await control.locator('[data-month="2026-11"]').innerText()).replace(/\s+/g, " ").trim()).toBe("Ноябрь 27 631,03 6 642,57 7 690,00 26 583,60");
    await seeText(control.locator("[data-note]"), "Ноябрь — по 16.11 включительно.");

    // A picture: a PNG of 760 px, twice as dense, whatever the window is.
    const [saved] = await Promise.all([page.waitForEvent("download"), top.getByRole("button", { name: "Скачать PNG" }).click()]);
    expect(saved.suggestedFilename()).toBe("dolgi-2026-11-16-2-top-30.png");
    const png = await readFile(await saved.path());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1520);
    expect(png.readUInt32BE(20)).toBeGreaterThan(300);
    // Not an empty one: a picture of a table of names weighs something.
    expect(png.length).toBeGreaterThan(20_000);

    // The sheet of Excel.
    const [sheet] = await Promise.all([page.waitForEvent("download"), report(page).getByRole("button", { name: "Excel: не платят больше 7 дней" }).click()]);
    expect(sheet.suggestedFilename()).toBe("ne-platyat-7-dney-2026-11-16.xlsx");
    expect((await readFile(await sheet.path())).subarray(0, 2).toString()).toBe("PK");
  });

  it("covers several days when compared with an earlier day, and steps from day to day", async () => {
    const started = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "ivan", "correct horse");
    await openSection(page, "Отчёты");
    await showDay(page, "2026-11-16");
    await report(page).locator("input[name=since]").fill("2026-11-13");
    const movement = picture(page, "movement");
    await seeText(movement.locator("[data-tile]").first(), "Долг на 13.11");
    await seeText(movement.locator("[data-tile]").nth(3), /за 3.дня/);
    await seeText(movement.locator('[data-list="paid"]'), "Кто оплатил 14–16.11");
    await seePlain(movement.locator("[data-tile]").nth(1), "рейсы 245 (14.11), 246 (15.11), 247 (16.11); 4 клиента");
    // The days one by one.
    const note = plain(await movement.locator("[data-note]").innerText());
    expect(note).toContain("14.11 — рейс 245 +3 000 → долг 30 331; 15.11 — рейс 246 +1 643 → долг 31 974; 16.11 — рейс 247 +2 000, оплачено 7 390 → долг 26 584.");
    await seeText(picture(page, "top").locator("thead"), "С 13.11");

    // A step back: the 15th against the 14th again.
    await report(page).getByRole("button", { name: "Предыдущий день" }).click();
    await seeValue(report(page).locator("input[name=day]"), "2026-11-15");
    await seeValue(report(page).locator("input[name=since]"), "2026-11-14");
    await seeText(movement.locator("[data-tile]").nth(3), "Долг на 15.11");
    await seeText(movement.locator("[data-tile]").nth(2), "оплат не было");
    // Nobody paid: the list of the charged takes the whole width, and there is no list of payers.
    await seeGone(movement.locator('[data-list="paid"]'));
    await seeText(movement.locator('[data-list="charged"]'), "Кому начислено 15.11");
  });

  it("fits a phone without the page running sideways, and is nobody's where there are no trips or no cash", async () => {
    const started = await business();
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await signIn(phone.page, started, "ivan", "correct horse");
    await openSection(phone.page, "Отчёты");
    await showDay(phone.page, "2026-11-16");
    await seePlain(picture(phone.page, "overdue").locator("[data-tile]").first(), "3 клиента");
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The picture from a phone is the same picture: as wide as from a computer.
    const [saved] = await Promise.all([phone.page.waitForEvent("download"), picture(phone.page, "movement").getByRole("button", { name: "Скачать PNG" }).click()]);
    expect((await readFile(await saved.path())).readUInt32BE(16)).toBe(1520);

    // The keeper of a warehouse has no such section.
    const keeper = await newLaptop(browser);
    contexts.push(keeper.context);
    await signIn(keeper.page, started, "sklad", "warehouse pass");
    const menu = keeper.page.getByRole("navigation", { name: "Разделы" });
    await seeVisible(menu.getByRole("button", { name: "Сборные грузы", exact: true }));
    await seeGone(menu.getByRole("button", { name: "Отчёты", exact: true }));

    // A business that keeps no trips has no debts to report.
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
