import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The admin keeps the people of the cash desk in «Управление» → «Люди». */
describe("the accounts on the admin's screen", () => {
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

  it("adds a person, gives a role, sets a password, blocks and deletes", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const { page } = await signedIn(started, "mudir", "admin password");

    await page.getByRole("tab", { name: "Управление", exact: true }).click();
    await page.getByRole("tab", { name: "Люди", exact: true }).click();
    const list = page.getByRole("region", { name: "Пользователи" });
    await seeText(list.locator('[data-user="mudir"]'), "(это вы)");

    // A new cashier, who can log in at once.
    const form = list.getByRole("form", { name: "Новый пользователь" });
    await form.getByRole("textbox", { name: "Имя" }).fill("Азиз");
    await form.getByRole("textbox", { name: "Логин" }).fill("aziz");
    await form.getByRole("textbox", { name: "Пароль" }).fill("first password");
    await form.getByRole("button", { name: "Добавить" }).click();
    await seeText(list.locator('[data-user="aziz"]'), "Кассир");
    await signedIn(started, "aziz", "first password");

    // Made an admin, with a new login and a new password.
    await list.getByRole("button", { name: "Действия: Азиз" }).click();
    await page.getByRole("menuitem", { name: "Изменить" }).click();
    const edit = list.getByRole("form", { name: "Изменить Азиз" });
    await edit.getByRole("textbox", { name: "Логин" }).fill("aziz2");
    await edit.getByRole("combobox", { name: "Роль" }).selectOption("admin");
    await edit.getByRole("button", { name: "Сохранить" }).click();
    await seeText(list.locator('[data-user="aziz2"]'), "Админ");

    await list.getByRole("button", { name: "Действия: Азиз" }).click();
    await page.getByRole("menuitem", { name: "Новый пароль" }).click();
    await list.getByRole("textbox", { name: "Новый пароль" }).fill("second password");
    await list.getByRole("button", { name: "Сменить пароль" }).click();
    await seeText(list, "Пароль Азиз сменён");
    await signedIn(started, "aziz2", "second password");

    // Blocked, then deleted (he wrote nothing).
    await list.getByRole("button", { name: "Действия: Азиз" }).click();
    await page.getByRole("menuitem", { name: "Отключить" }).click();
    await seeText(list.locator('[data-user="aziz2"]'), "отключён");
    await list.getByRole("button", { name: "Действия: Азиз" }).click();
    await page.getByRole("menuitem", { name: "Удалить" }).click();
    await list.getByRole("group", { name: "Удалить Азиз" }).getByRole("button", { name: "Удалить" }).click();
    await seeGone(list.locator('[data-user="aziz2"]'));

    // The admin cannot block or delete himself.
    await list.getByRole("button", { name: "Действия: Админ" }).click();
    await seeVisible(page.getByRole("menuitem", { name: "Изменить" }));
    await seeGone(page.getByRole("menuitem", { name: "Отключить" }));
    await seeGone(page.getByRole("menuitem", { name: "Удалить" }));
  }, 120_000);

  it("is not shown to the owner", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const { page } = await signedIn(started, "owner", "long enough pass");
    await seeVisible(page.getByRole("tab", { name: "Категории", exact: true }));
    await seeGone(page.getByRole("tab", { name: "Люди", exact: true }));
  }, 60_000);
});
