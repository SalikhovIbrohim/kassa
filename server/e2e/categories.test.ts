import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeVisible, openSection } from "./browser.js";

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
    await phone.page.locator("[data-signed-in]:visible").first().waitFor();
    return phone;
  }

  const options = (page: Page) => page.locator("select[name=category]:visible option");

  /** "+ Новая" opens a window: income or expense, the name, the ticks. */
  async function addCategory(page: Page, kind: "Приход" | "Расход", label: string, ticks: string[] = []) {
    await page.getByRole("button", { name: "+ Новая" }).click();
    const dialog = page.getByRole("dialog", { name: "Новая категория" });
    await dialog.getByText(kind, { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Название" }).fill(label);
    for (const tick of ticks) await dialog.getByRole("checkbox", { name: tick }).check();
    await dialog.getByRole("button", { name: "Добавить" }).click();
    return dialog;
  }

  it("are changed by the owner, and the cashier's forms ask for the category: a client only where the category names one", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const owner = await signedIn(started, "owner", "long enough pass");

    // The owner adds an expense category and an income category, and archives one.
    await openSection(owner.page, "Категории");
    const expenseList = owner.page.locator('tbody[data-kind="expense"]');
    await addCategory(owner.page, "Расход", "Ремонт склада");
    await seeGone(owner.page.getByRole("dialog"));
    await seeText(expenseList, "Ремонт склада");

    const incomeList = owner.page.locator('tbody[data-kind="income"]');
    await addCategory(owner.page, "Приход", "Аренда мест");
    await seeText(incomeList, "Аренда мест");

    // The pencil opens the category; the archive is in there.
    await expenseList.getByRole("button", { name: "Изменить: Билеты" }).click();
    await expenseList.getByRole("form", { name: "Изменить категорию Билеты" }).getByRole("button", { name: "В архив" }).click();
    await seeText(expenseList.locator('[data-category="tickets"]'), "в архиве");

    // The same label twice in a list is said no to.
    const dialog = await addCategory(owner.page, "Расход", "обед склад");
    await seeVisible(dialog.getByRole("alert").filter({ hasText: "Такая категория уже есть" }));
    await dialog.getByRole("button", { name: "Отмена" }).click();
    await seeGone(owner.page.getByRole("dialog"));

    // The cashier sees the lists as they are now.
    const { page } = await signedIn(started, "ivan", "correct horse");
    await page.getByRole("tab", { name: "Расход", exact: true }).click();
    const expenseOptions = await options(page).allInnerTexts();
    expect(expenseOptions).toContain("Ремонт склада");
    expect(expenseOptions).toContain("Оплата фура");
    expect(expenseOptions).not.toContain("Билеты");

    await page.getByRole("tab", { name: "Приход", exact: true }).click();
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
    await page.getByRole("tab", { name: "Журнал", exact: true }).click();
    await seeText(page.getByRole("table", { name: "Журнал операций" }), "Взяли долг");
  }, 120_000);

  it("are one table: the ticks and the type change right in the row", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const owner = await signedIn(started, "owner", "long enough pass");
    await openSection(owner.page, "Категории");
    const incomeList = owner.page.locator('tbody[data-kind="income"]');
    const expenseList = owner.page.locator('tbody[data-kind="expense"]');
    await seeText(incomeList, "Взяли долг");

    // A tick is saved at once, and is there after the screen is loaded again.
    await expenseList.getByRole("checkbox", { name: "Нужен сотрудник: Зарплаты и выплаты" }).check();
    await owner.page.reload();
    await openSection(owner.page, "Категории");
    await expect.poll(() => expenseList.getByRole("checkbox", { name: "Нужен сотрудник: Зарплаты и выплаты" }).isChecked()).toBe(true);

    // The city is chosen right in the row and kept.
    await expenseList.getByRole("combobox", { name: "Город: Таможня" }).selectOption("moscow");
    await owner.page.reload();
    await openSection(owner.page, "Категории");
    await expect.poll(() => expenseList.getByRole("combobox", { name: "Город: Таможня" }).inputValue()).toBe("moscow");
    // No more arrows: the order is changed by dragging.
    expect(await expenseList.getByRole("button", { name: /^Выше:/ }).count()).toBe(0);

    // A new income category made by mistake becomes an expense one, at the end of that list.
    await addCategory(owner.page, "Приход", "Стоянка");
    await seeText(incomeList, "Стоянка");
    await incomeList.getByRole("combobox", { name: "Тип: Стоянка" }).selectOption("expense");
    await seeText(expenseList.locator("tr[data-category]").last(), "Стоянка");
    // The payment of a client keeps its type.
    expect(await incomeList.getByRole("combobox", { name: "Тип: Оплата от клиента" }).isDisabled()).toBe(true);
  }, 90_000);

  it("are put in order by dragging a row with the mouse on a laptop", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const owner = await signedIn(started, "owner", "long enough pass");
    // Tall enough for the whole table: a drag that has to scroll is not what is tested here.
    await owner.page.setViewportSize({ width: 1100, height: 1700 });
    await openSection(owner.page, "Категории");
    const expenseList = owner.page.locator('tbody[data-kind="expense"]');
    const order = () => expenseList.locator("tr[data-category]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-category")));
    await expenseList.locator('[data-category="customs"]').waitFor();
    expect((await order()).slice(0, 2)).toEqual(["fuel_road", "salaries"]);

    // "Таможня" is dropped on the upper half of the first row: it becomes the first.
    const first = expenseList.locator('[data-category="fuel_road"]');
    await expenseList.locator('[data-category="customs"] [title="Перетащите, чтобы поменять порядок"]').dragTo(first, { targetPosition: { x: 40, y: 4 } });

    await expect.poll(async () => (await order()).slice(0, 3)).toEqual(["customs", "fuel_road", "salaries"]);
    // The order is the server's, also after the screen is loaded again.
    await owner.page.reload();
    await openSection(owner.page, "Категории");
    await expect.poll(async () => (await order()).slice(0, 1)).toEqual(["customs"]);
  }, 90_000);

  it("ask for the number of the trip and the counterparty where the owner ticked them, and the entry is not saved without them", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const owner = await signedIn(started, "owner", "long enough pass");

    await openSection(owner.page, "Категории");
    const expenseList = owner.page.locator('tbody[data-kind="expense"]');
    await addCategory(owner.page, "Расход", "Перевозчику", ["Нужен номер рейса", "Нужен контрагент", "Нужен сотрудник"]);
    await seeText(expenseList, "Перевозчику");
    for (const tick of ["Нужен номер рейса", "Нужен контрагент", "Нужен сотрудник"]) {
      await expect.poll(() => expenseList.getByRole("checkbox", { name: `${tick}: Перевозчику` }).isChecked()).toBe(true);
    }
    expect(await expenseList.getByRole("checkbox", { name: "Нужен код клиента: Перевозчику" }).isChecked()).toBe(false);

    const { page } = await signedIn(started, "ivan", "correct horse");
    await page.getByRole("tab", { name: "Расход", exact: true }).click();
    await page.getByRole("textbox", { name: "Сумма" }).fill("500");
    await seeGone(page.locator("input[name=tripNumber]"));
    await page.locator("select[name=category]:visible").selectOption({ label: "Перевозчику" });

    // Without the trip and the counterparty the entry stays on the phone, unsaved.
    await page.getByRole("button", { name: "Записать расход" }).click();
    await expect.poll(() => page.locator(".success:visible").count()).toBe(0);

    // The number of a trip takes only digits.
    await page.getByRole("textbox", { name: "Номер рейса" }).pressSequentially("19x4");
    expect(await page.getByRole("textbox", { name: "Номер рейса" }).inputValue()).toBe("194");
    await page.getByRole("textbox", { name: "Контрагент" }).fill("ООО Трасса");
    await page.getByRole("button", { name: "Записать расход" }).click();
    await expect.poll(() => page.locator(".success:visible").count()).toBe(0);
    await page.getByRole("textbox", { name: "Сотрудник" }).fill("Бахтиёр");
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(page.locator(".success:visible"), "Записано: Перевозчику");

    await page.getByRole("tab", { name: "Журнал", exact: true }).click();
    const journal = page.getByRole("table", { name: "Журнал операций" });
    await seeText(journal, "Рейс 194");
    await seeText(journal, "Контрагент: ООО Трасса");
    await seeText(journal, "Сотрудник: Бахтиёр");
  }, 120_000);
});
