import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

    // A new cashier, from the window of «+ Новый»; he can log in at once.
    await list.getByRole("button", { name: "+ Новый" }).click();
    const form = page.getByRole("dialog", { name: "Новый пользователь" });
    await form.getByRole("textbox", { name: "Имя" }).fill("Азиз");
    await form.getByRole("textbox", { name: "Логин" }).fill("aziz");
    await form.getByRole("textbox", { name: "Пароль" }).fill("first password");
    await form.getByRole("button", { name: "Добавить" }).click();
    await seeGone(page.getByRole("dialog"));
    await seeText(list.locator('[data-user="aziz"]'), "Кассир");
    await signedIn(started, "aziz", "first password");

    // The pencil opens everything: made a head cashier, with a new login and a new password, in one save.
    await list.getByRole("button", { name: "Изменить: Азиз" }).click();
    const edit = list.getByRole("form", { name: "Изменить Азиз" });
    await edit.getByRole("textbox", { name: "Логин" }).fill("aziz2");
    await edit.getByRole("combobox", { name: "Роль" }).selectOption("head_cashier");
    await edit.getByRole("textbox", { name: /Новый пароль/ }).fill("second password");
    await edit.getByRole("button", { name: "Сохранить" }).click();
    await seeText(list.locator('[data-user="aziz2"]'), "Главный кассир");
    await seeText(list, "Пароль Азиз сменён");
    await signedIn(started, "aziz2", "second password");

    // Blocked, then deleted (he wrote nothing), from the same place.
    await list.getByRole("button", { name: "Изменить: Азиз" }).click();
    await list.getByRole("form", { name: "Изменить Азиз" }).getByRole("button", { name: "Отключить" }).click();
    await seeText(list.locator('[data-user="aziz2"]'), "отключён");
    await list.getByRole("button", { name: "Изменить: Азиз" }).click();
    await list.getByRole("form", { name: "Изменить Азиз" }).getByRole("button", { name: "Удалить" }).click();
    await list.getByRole("group", { name: "Удалить Азиз" }).getByRole("button", { name: "Да, удалить" }).click();
    await seeGone(list.locator('[data-user="aziz2"]'));

    // The admin cannot block or delete himself, nor change his role.
    await list.getByRole("button", { name: "Изменить: Админ" }).click();
    const own = list.getByRole("form", { name: "Изменить Админ" });
    await seeVisible(own.getByRole("button", { name: "Сохранить" }));
    await seeGone(own.getByRole("button", { name: "Отключить" }));
    await seeGone(own.getByRole("button", { name: "Удалить" }));
    expect(await own.getByRole("combobox", { name: "Роль" }).isDisabled()).toBe(true);
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
