import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newPhone, openSection, seeText, seeVisible, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** A guest is shown the cash desk: he tries the forms, and nothing of what he types is saved. */
describe("the guest's screen", () => {
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

  it("shows the forms and the journal, saves nothing, and has no clients, categories or people", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "guest", password: "only looking 1", role: "guest", displayName: "Гость" });
    await started.admin.setOpeningBalance("USD", "100");
    const phone = await newPhone(browser);
    context = phone.context;
    const page = phone.page;
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill("guest");
    await page.getByLabel("Пароль").fill("only looking 1");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();

    const tabs = page.getByRole("tablist", { name: "Основные разделы" });
    expect(await tabs.getByRole("tab").allInnerTexts()).toEqual(["Приход", "Расход", "Журнал", "Итоги", "Настройки"]);
    await seeText(page.getByRole("note"), "записи не сохраняются");

    // He fills an expense and presses the button: he is told it is not saved, and it is not.
    await openSection(page, "Расход");
    await choose(selectField(page, "category"), "fuel_road");
    await page.getByRole("radio", { name: "Доллары" }).locator("visible=true").first().check({ force: true });
    await page.getByRole("textbox", { name: "Сумма" }).locator("visible=true").first().fill("5");
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeVisible(page.getByRole("alert").filter({ hasText: "записи не сохраняются" }).locator("visible=true").first());
    expect(await started.query("SELECT count(*)::int AS n FROM operations")).toEqual([{ n: 0 }]);
    // Nothing waits on the phone either.
    expect(await page.getByText("Не отправлено").count()).toBe(0);
    await seeText(page.getByRole("region", { name: "Остатки" }).locator("visible=true").first(), /100,00\s\$/);

    await openSection(page, "Журнал");
    await seeVisible(page.getByText("По этим условиям записей нет.").locator("visible=true").first());

    await tabs.getByRole("tab", { name: "Настройки" }).click();
    const sections = page.getByRole("navigation", { name: "Все разделы" });
    await seeVisible(sections.getByRole("button", { name: "Сверки", exact: true }));
    for (const hidden of ["Клиенты", "Категории", "Люди", "Сверка"]) expect(await sections.getByRole("button", { name: hidden, exact: true }).count()).toBe(0);
  }, 90_000);
});
