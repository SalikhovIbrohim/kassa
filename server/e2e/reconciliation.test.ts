import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeVisible, openSection, backToCashDesk, cashMenu } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** No shifts to open or close: one journal for everybody, and the head cashier's button that counts the cash. In a real browser against the real server. */
describe("the cash desk without shifts", () => {
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

  async function desk() {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "anvar", password: "admin pass word", role: "head_cashier", displayName: "Анвар" });
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "1000");
    await started.admin.setOpeningBalance("USD", "50");
    const phoneOf = async (login: string, password: string) => {
      const phone = await newPhone(browser);
      contexts.push(phone.context);
      await phone.page.goto(started.baseUrl);
      await phone.page.getByLabel("Логин").fill(login);
      await phone.page.getByLabel("Пароль").fill(password);
      await phone.page.getByRole("button", { name: "Войти" }).click();
      await phone.page.locator("[data-signed-in]:visible").first().waitFor();
      return phone;
    };
    return { started, phoneOf };
  }

  const bar = (page: Page) => page.getByRole("region", { name: "Сверка кассы", exact: true });
  const showJournal = (page: Page) => cashMenu(page, "Журнал");
  const amountField = (page: Page) => page.getByRole("textbox", { name: "Сумма" });
  const countField = (page: Page, currency: "RUB" | "USD" | "card") => page.locator(`input[name=count-${currency}]`);

  async function enterIncome(page: Page, amount: string, clientCode: string) {
    await page.getByRole("tab", { name: "Приход", exact: true }).click();
    await amountField(page).fill(amount);
    await page.locator("input[name=rate]:visible").fill("79");
    await page.locator("input[name=clientCode]").fill(clientCode);
    await page.getByRole("button", { name: "Записать приход" }).click();
  }

  async function countWith(page: Page, rub: string, usd: string) {
    await showJournal(page);
    await page.getByRole("button", { name: "Сверить кассу" }).first().click();
    await countField(page, "RUB").fill(rub);
    await countField(page, "USD").fill(usd);
    await countField(page, "card").fill("0");
    await page.getByRole("button", { name: "Сверить кассу" }).last().click();
  }

  it("has no shift on the cashier's screen: nothing to open, nothing to close, and no button to count the cash", async () => {
    const { phoneOf } = await desk();
    const ivan = await phoneOf("ivan", "correct horse");

    await showJournal(ivan.page);

    await seeVisible(ivan.page.getByRole("heading", { name: "Журнал" }).first());
    expect(await ivan.page.getByRole("region", { name: "Смена", exact: true }).count()).toBe(0);
    expect(await ivan.page.getByRole("button", { name: "Открыть смену" }).count()).toBe(0);
    expect(await ivan.page.getByRole("button", { name: "Сверить кассу" }).count()).toBe(0);
  }, 90_000);

  it("shows a cashier the entries of the colleagues too, with who entered each, and lets them change only their own", async () => {
    const { started, phoneOf } = await desk();
    const petr = await loginAs(started, "petr", "another good one");
    await postJson(started, "/api/operations", { id: randomUUID(), type: "income", amountMinor: 65_400, currency: "RUB", rateE4: 790_000, clientCode: "THEIRS-1" }, petr);
    const ivan = await phoneOf("ivan", "correct horse");
    await enterIncome(ivan.page, "321", "MINE-1");
    await seeText(ivan.page.locator(".success"), "Записано: приход");

    await showJournal(ivan.page);

    const table = ivan.page.getByRole("table", { name: "Журнал операций" });
    await seeText(table, "THEIRS-1");
    await seeText(table, "MINE-1");
    const theirs = table.locator("tr", { hasText: "THEIRS-1" });
    const mine = table.locator("tr", { hasText: "MINE-1" });
    await seeText(theirs, "Пётр");
    // On a phone the own entry shows its buttons where the name of a colleague stands.
    expect(await mine.getByRole("button", { name: /Изменить/ }).count()).toBe(1);
    expect(await mine.getByRole("button", { name: /Удалить/ }).count()).toBe(1);
    expect(await theirs.getByRole("button", { name: /Изменить/ }).count()).toBe(0);
    expect(await theirs.getByRole("button", { name: /Удалить/ }).count()).toBe(0);
  }, 90_000);

  it("lets the head cashier enter entries like a cashier, and shows him the button that counts the cash in the journal", async () => {
    const { phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await seeText(anvar.page.locator(".role"), "Главный кассир");

    await enterIncome(anvar.page, "654", "ADM-1");
    await seeText(anvar.page.locator(".success"), "Записано: приход");
    await showJournal(anvar.page);

    await seeText(anvar.page.getByRole("table", { name: "Журнал операций" }), "ADM-1");
    await seeVisible(bar(anvar.page).getByRole("button", { name: "Сверить кассу" }));
  }, 90_000);

  it("counts the cash, says how it came out, and the books say what was counted", async () => {
    const { phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await enterIncome(anvar.page, "654", "ADM-CLOSE");
    await seeText(anvar.page.locator(".success"), "Записано: приход");

    await countWith(anvar.page, "1640", "50");

    // The books said 1 654,00 (1 000,00 opening and 654,00 in): the cash desk was 14,00 short.
    await seeText(bar(anvar.page), "Касса сверена");
    await seeText(bar(anvar.page), /Рубли: по книге 1\s654,00\s₽, насчитано 1\s640,00\s₽ \(наличными 1\s640,00\s₽, на карте 0,00\s₽\)\. Недостача 14,00\s₽\./);
    await seeText(bar(anvar.page), /Доллары: по книге 50,00\s\$, насчитано 50,00\s\$\. Сошлось\./);
    await seeText(anvar.page.getByRole("region", { name: "Остатки" }), /1\s640,00\s₽/);
    // It can be done again whenever the head cashier likes.
    await seeVisible(bar(anvar.page).getByRole("button", { name: "Сверить кассу" }));
  }, 90_000);

  it("asks for a count of both currencies, and takes zero as a count", async () => {
    const { phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await showJournal(anvar.page);
    await anvar.page.getByRole("button", { name: "Сверить кассу" }).click();

    await countField(anvar.page, "RUB").fill("1000");
    await anvar.page.getByRole("button", { name: "Сверить кассу" }).last().click();
    await seeVisible(anvar.page.getByRole("alert").filter({ hasText: "Введите, сколько насчитали, по каждой валюте" }));

    await countField(anvar.page, "USD").fill("0");
    await anvar.page.getByRole("button", { name: "Сверить кассу" }).last().click();
    await seeVisible(anvar.page.getByRole("alert").filter({ hasText: "сколько на карте" }));

    await countField(anvar.page, "card").fill("0");
    await anvar.page.getByRole("button", { name: "Сверить кассу" }).last().click();
    await seeText(bar(anvar.page), /наличными 1\s000,00\s₽, на карте 0,00\s₽/);
    await seeText(bar(anvar.page), /Доллары: по книге 50,00\s\$, насчитано 0,00\s\$\. Недостача 50,00\s\$\./);
  }, 90_000);

  it("shows the owner the count with its difference, in the list of counts and in the totals", async () => {
    const { phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await countWith(anvar.page, "990", "50");
    await seeText(bar(anvar.page), "Касса сверена");

    const owner = await phoneOf("owner", "long enough pass");
    await openSection(owner.page, "Сверки");

    const card = owner.page.locator(".reconciliation-card").first();
    await seeText(card, "Анвар");
    await seeText(card.locator('[data-currency="RUB"]'), /по книге 1\s000,00\s₽, насчитано 990,00\s₽/);
    await seeText(card.locator('[data-currency="RUB"] [data-difference]'), /−10,00\s₽/);
    await seeText(card.locator('[data-currency="USD"] [data-difference]'), "сошлось");

    await openSection(owner.page, "Итоги");
    await seeText(owner.page.locator('[data-total="difference"]').first(), /−10,00\s₽/);
    await seeText(owner.page.locator('[data-total="closing"]').first(), /990,00\s₽/);
  }, 90_000);

  it("gives the admin the owner's screen as well, behind \"Управление\", but not the button that counts the cash", async () => {
    const { started, phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await countWith(anvar.page, "990", "50");
    await seeText(bar(anvar.page), "Касса сверена");
    // After the count: 990,00 ₽ in the box, and 100,00 ₽ more from a colleague.
    const petr = await loginAs(started, "petr", "another good one");
    await postJson(started, "/api/operations", { id: randomUUID(), type: "income", amountMinor: 10_000, currency: "RUB", rateE4: 790_000, clientCode: "PETR-1" }, petr);

    const mudir = await phoneOf("mudir", "admin password");
    await cashMenu(mudir.page, "Управление");
    await openSection(mudir.page, "Сверки");
    await seeText(mudir.page.locator(".reconciliation-card").first(), "Анвар");
    await openSection(mudir.page, "Итоги");
    await seeText(mudir.page.locator('[data-total="difference"]').first(), /−10,00\s₽/);
    await openSection(mudir.page, "Категории");
    await seeVisible(mudir.page.getByRole("banner").getByRole("heading", { name: "Категории" }));

    // His one journal is the one of «Управление»: there he corrects anybody's entry.
    await openSection(mudir.page, "Журнал");
    const row = mudir.page.getByRole("table", { name: "Журнал операций" }).locator("tr", { hasText: "PETR-1" });
    await row.getByRole("button", { name: /Изменить/ }).click();
    await mudir.page.locator("input[name=amount]:visible").fill("150");
    await mudir.page.getByRole("button", { name: "Сохранить" }).click();
    await seeText(mudir.page.getByRole("table", { name: "Журнал операций" }).locator("tr", { hasText: "PETR-1" }), /150,00\s₽/);
    await seeText(mudir.page.getByRole("region", { name: "Остатки" }).first(), /1\s140,00\s₽/);

    // At the cash desk he enters like a cashier, with no journal of its own; only the head cashier counts the cash.
    await backToCashDesk(mudir.page);
    await seeVisible(mudir.page.getByRole("tab", { name: "Приход", exact: true }));
    const burger = mudir.page.getByRole("button", { name: "Меню", exact: true });
    if (await burger.isVisible()) await burger.click();
    expect(await mudir.page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Журнал", exact: true }).count()).toBe(0);
    expect(await mudir.page.getByRole("button", { name: "Сверить кассу" }).count()).toBe(0);
  }, 90_000);

  it("does not give the owner the pencil in the journal", async () => {
    const { started, phoneOf } = await desk();
    const petr = await loginAs(started, "petr", "another good one");
    await postJson(started, "/api/operations", { id: randomUUID(), type: "income", amountMinor: 10_000, currency: "RUB", rateE4: 790_000, clientCode: "PETR-2" }, petr);
    const owner = await phoneOf("owner", "long enough pass");
    const row = owner.page.getByRole("table", { name: "Журнал операций" }).locator("tr", { hasText: "PETR-2" });
    await seeText(row, "PETR-2");
    expect(await row.getByRole("button", { name: /Изменить|Удалить/ }).count()).toBe(0);
  }, 90_000);

  it("does not count the cash while an entry waits on the phone", async () => {
    const { phoneOf } = await desk();
    const anvar = await phoneOf("anvar", "admin pass word");
    await anvar.page.evaluate(() => navigator.serviceWorker.ready);
    await anvar.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await anvar.context.setOffline(true);
    await enterIncome(anvar.page, "100", "ADM-WAIT");
    await seeVisible(anvar.page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));

    await showJournal(anvar.page);
    await anvar.page.getByRole("button", { name: "Сверить кассу" }).click();

    await seeVisible(anvar.page.getByRole("alert").filter({ hasText: "ждёт 1 запись" }));
    expect(await anvar.page.getByRole("button", { name: "Сверить кассу" }).last().isDisabled()).toBe(true);
    await anvar.context.setOffline(false);
    await seeGone(anvar.page.getByRole("region", { name: /ещё не дошли/ }));
  }, 90_000);
});
