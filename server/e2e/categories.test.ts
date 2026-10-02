import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The owner keeps the lists of categories, and the cashier's drop-down lists follow. */
describe("the lists of categories", () => {
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

  async function signedIn(started: TestApp, login: string, password: string) {
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await phone.page.goto(started.baseUrl);
    await phone.page.getByLabel("Логин").fill(login);
    await phone.page.getByLabel("Пароль").fill(password);
    await phone.page.getByRole("button", { name: "Войти" }).click();
    await phone.page.getByRole("button", { name: "Выйти" }).waitFor();
    return phone;
  }

  const options = (page: Page) => page.locator("select[name=category]:visible option");

  it("are changed by the owner, and the cashier's forms ask for the category: a client only where the category names one", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const owner = await signedIn(started, "owner", "long enough pass");

    // The owner adds an expense category and an income category, and archives one.
    await owner.page.getByRole("button", { name: "Категории", exact: true }).click();
    const expenseList = owner.page.getByRole("region", { name: "Категории: расход" });
    await expenseList.getByRole("textbox", { name: "Новая категория" }).fill("Ремонт склада");
    await expenseList.getByRole("button", { name: "Добавить" }).click();
    await seeText(expenseList, "Ремонт склада");

    const incomeList = owner.page.getByRole("region", { name: "Категории: приход" });
    await incomeList.getByRole("textbox", { name: "Новая категория" }).fill("Аренда мест");
    await incomeList.getByRole("button", { name: "Добавить" }).click();
    await seeText(incomeList, "Аренда мест");

    await expenseList.getByRole("button", { name: "В архив: Билеты" }).click();
    await seeText(expenseList.locator('[data-category="tickets"]'), "в архиве");

    // The same label twice in a list is said no to.
    await expenseList.getByRole("textbox", { name: "Новая категория" }).fill("обед склад");
    await expenseList.getByRole("button", { name: "Добавить" }).click();
    await seeVisible(owner.page.getByRole("alert").filter({ hasText: "Такая категория уже есть" }));

    // The cashier sees the lists as they are now.
    const { page } = await signedIn(started, "ivan", "correct horse");
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    const expenseOptions = await options(page).allInnerTexts();
    expect(expenseOptions).toContain("Ремонт склада");
    expect(expenseOptions).toContain("Оплата фура");
    expect(expenseOptions).not.toContain("Билеты");

    await page.getByRole("button", { name: "Приход", exact: true }).click();
    const incomeOptions = await options(page).allInnerTexts();
    expect(incomeOptions).toEqual(["Оплата от клиента", "Взяли долг", "Приход от субаренды", "Сотрудник вернул долг", "Прочее", "Аренда мест"]);

    // A payment of a client names the client; a debt does not, and the field is gone.
    await seeVisible(page.locator("input[name=clientCode]"));
    await page.locator("select[name=category]:visible").selectOption({ label: "Взяли долг" });
    await seeGone(page.locator("input[name=clientCode]"));
    await page.getByRole("textbox", { name: "Сумма" }).fill("79000");
    await page.locator("input[name=rate]:visible").fill("79");
    await page.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success:visible"), "Записано: приход");
    await seeText(page.locator(".success:visible"), "(Взяли долг)");

    // The journal names the income by its category.
    await page.getByRole("button", { name: "Журнал", exact: true }).click();
    await seeText(page.getByRole("table", { name: "Журнал операций" }), "Взяли долг");
  }, 120_000);
});
