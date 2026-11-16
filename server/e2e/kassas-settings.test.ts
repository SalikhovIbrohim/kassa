import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { parseKassas } from "../src/kassa.js";
import { get, loginAs, patchJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newLaptop, newPhone, openSection, optionsOf, seeGone, seeText, seeVisible, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * Another business on the same screens: three desks (Moscow, Andijan, Tashkent), all of dollars only. The screens
 * know of it only what the server tells them.
 */
describe("three cash desks of dollars", () => {
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
    const started = await startTestApp({ webDistDir, kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD") });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "timur", password: "tashkent cashier", role: "cashier", displayName: "Тимур" });
    await started.admin.createUser({ login: "anvar", password: "counts every desk", role: "head_cashier", displayName: "Анвар" });
    // A different sum in each desk, and entries of a third sum: no two balances are ever alike by chance.
    await started.admin.setOpeningBalance("USD", "50");
    await started.admin.setOpeningBalance("USD", "70", "tashkent");
    await started.admin.setOpeningBalance("USD", "90", "andijan");
    const mudir = await loginAs(started, "mudir", "admin password");
    const users = (await (await get(started, "/api/admin/users", mudir)).json()).users as Array<{ id: string; login: string }>;
    await patchJson(started, `/api/admin/users/${users.find((user) => user.login === "timur")!.id}`, { city: "tashkent" }, mudir);

    const signIn = async (page: Page, login: string, password: string) => {
      await page.goto(started.baseUrl);
      await page.getByLabel("Логин").fill(login);
      await page.getByLabel("Пароль").fill(password);
      await page.getByRole("button", { name: "Войти" }).click();
      await page.locator("[data-signed-in]:visible").first().waitFor();
    };
    const operations = async (query = "") =>
      (await (await get(started, `/api/operations${query}`, mudir)).json()).operations as Array<{ kassa: string; currency: string; amountMinor: number }>;
    return { started, signIn, mudir, operations };
  }

  const balances = (page: Page) => page.getByRole("region", { name: "Остатки" }).first();
  const kassaChoice = (page: Page) => page.getByRole("group", { name: "Касса" }).locator("visible=true").first();

  async function spend(page: Page, amount: string) {
    await openSection(page, "Расход");
    const form = page.locator("form:visible").first();
    await choose(selectField(form, "category"), "fuel_road");
    await form.getByRole("textbox", { name: "Сумма" }).fill(amount);
    await form.getByRole("button", { name: "Записать расход" }).click();
    return form;
  }

  it("gives a cashier of Tashkent their desk: its name, its balance, dollars and nothing to choose", async () => {
    const { signIn, operations } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "timur", "tashkent cashier");

    await seeText(balances(page), "Остаток · Ташкент");
    await seeText(balances(page), /70,00\s\$/);
    const form = await spend(page, "5");
    await seeText(balances(page), /65,00\s\$/);
    expect(await balances(page).textContent()).not.toContain("₽");
    // No rubles to choose, and no other desk to go to.
    expect(await form.getByText("Рубли", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("group", { name: "Касса" }).count()).toBe(0);
    await expect.poll(() => operations()).toEqual([expect.objectContaining({ kassa: "tashkent", currency: "USD", amountMinor: 500 })]);
  }, 90_000);

  it("lets the admin choose among the three desks on a phone: each has its own balance, and the entry goes to the one chosen", async () => {
    const { signIn, operations } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "mudir", "admin password");

    // The main desk first: Moscow, which keeps no rubles here.
    expect(await kassaChoice(page).getByRole("button").allInnerTexts()).toEqual(["Москва", "Андижан", "Ташкент"]);
    await seeText(balances(page), /50,00\s\$/);
    expect(await balances(page).textContent()).not.toContain("₽");

    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await seeText(balances(page), /70,00\s\$/);
    await spend(page, "5");
    await seeText(balances(page), /65,00\s\$/);
    await expect.poll(() => operations("?kassa=tashkent")).toHaveLength(1);
    expect(await operations("?kassa=moscow")).toHaveLength(0);

    await kassaChoice(page).getByRole("button", { name: "Андижан" }).click();
    await seeText(balances(page), /90,00\s\$/);
    await kassaChoice(page).getByRole("button", { name: "Москва" }).click();
    await seeText(balances(page), /50,00\s\$/);
    // Nothing of the three buttons is cut off or pushed out of the screen.
    for (const button of await kassaChoice(page).getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }, 90_000);

  it("shows the journal of one desk or of all three, each entry marked with its desk, and the balances of each desk apart", async () => {
    const { signIn } = await desk();
    const { context, page } = await newLaptop(browser);
    contexts.push(context);
    await signIn(page, "mudir", "admin password");
    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await spend(page, "5");
    await seeText(balances(page), /65,00\s\$/);

    await openSection(page, "Журнал");
    expect(await kassaChoice(page).getByRole("button").allInnerTexts()).toEqual(["Все", "Москва", "Андижан", "Ташкент"]);
    const all = page.getByRole("region", { name: "Остатки" }).locator("visible=true").first();
    await seeText(all, "Остатки по кассам");
    await seeText(all.locator('[data-kassa="tashkent"]'), /Ташкент\s*65,00\s\$/);
    await seeText(all.locator('[data-kassa="moscow"]'), /Москва\s*50,00\s\$/);
    await seeText(all.locator('[data-kassa="andijan"]'), /Андижан\s*90,00\s\$/);
    expect(await all.textContent()).not.toContain("₽");
    await seeText(page.locator(".kassa-mark:visible").first(), "ТШК");

    await kassaChoice(page).getByRole("button", { name: "Андижан" }).click();
    await seeGone(page.locator(".kassa-mark:visible"));
    await seeText(page.getByRole("region", { name: "Остатки" }).locator("visible=true").first(), "Остаток · Андижан");
    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await seeVisible(page.locator("tr.expense:visible").first());
    // One desk is shown: an entry does not say which.
    expect(await page.locator(".kassa-mark:visible").count()).toBe(0);
  }, 90_000);

  it("does not take the balance of one desk for another's when an entry of the first is sent while the second is shown", async () => {
    const { signIn, operations } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "mudir", "admin password");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await seeText(balances(page), /70,00\s\$/);

    // Entered for Tashkent without a connection; then Moscow is looked at, and the connection comes back.
    await context.setOffline(true);
    await spend(page, "5");
    await seeVisible(page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));
    await kassaChoice(page).getByRole("button", { name: "Москва" }).click();
    await context.setOffline(false);

    await expect.poll(() => operations("?kassa=tashkent"), { timeout: 20_000 }).toHaveLength(1);
    // The answer of that entry carries the balance of Tashkent (65), in the same money as Moscow's (50): it is Moscow's
    // that stays on the screen, also a moment later.
    await seeText(balances(page), /50,00\s\$/);
    await page.waitForTimeout(1_500);
    expect(await balances(page).innerText()).toMatch(/50,00\s\$/);
    expect(await balances(page).innerText()).not.toMatch(/65,00/);
    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await seeText(balances(page), /65,00\s\$/);
  }, 90_000);

  it("names the desk that is counted, on the form and in the result, and in the list of counts of all the desks", async () => {
    const { started, signIn, mudir } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    // A head cashier of everywhere counts whichever desk is chosen over the forms.
    await signIn(page, "anvar", "counts every desk");
    await kassaChoice(page).getByRole("button", { name: "Ташкент" }).click();
    await seeText(balances(page), /70,00\s\$/);

    await openSection(page, "Журнал");
    await page.getByRole("button", { name: "Сверить кассу" }).first().click();
    const bar = page.getByRole("region", { name: "Сверка кассы", exact: true }).locator("visible=true").first();
    // Three desks of dollars: the one field says nothing about whose money is counted, so the form does.
    await seeText(bar, "Сверка кассы «Ташкент».");
    await seeText(bar, "введите остаток долларов");
    await page.locator("input[name=count-USD]").fill("68");
    await page.getByRole("button", { name: "Сверить кассу" }).last().click();
    await seeText(bar, "Касса «Ташкент» сверена");
    await seeText(bar, /Недостача 2,00\s\$/);

    const counts = (await (await get(started, "/api/reconciliations", mudir)).json()).reconciliations as Array<{ kassa: string; currencies: Array<{ actualMinor: number }> }>;
    expect(counts.map((count) => [count.kassa, count.currencies[0]!.actualMinor])).toEqual([["tashkent", 6_800]]);
    const moscow = (await (await get(started, "/api/balances?kassa=moscow", mudir)).json()).balances as Array<{ amountMinor: number }>;
    expect(moscow[0]!.amountMinor).toBe(5_000);

    // The admin's list: among all the desks a count says whose it is; in the list of one desk it need not.
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    await signIn(laptop.page, "mudir", "admin password");
    await openSection(laptop.page, "Сверки");
    const card = laptop.page.locator(".reconciliation-card:visible").first();
    await seeText(card.locator(".kassa-mark"), "ТШК");
    await kassaChoice(laptop.page).getByRole("button", { name: "Ташкент" }).click();
    await seeVisible(laptop.page.locator(".reconciliation-card:visible").first());
    await seeGone(laptop.page.locator(".reconciliation-card:visible .kassa-mark"));
  }, 90_000);

  it("offers the three cities for a person, and a person given Tashkent works in its desk", async () => {
    const { started, signIn } = await desk();
    await started.admin.createUser({ login: "aziz", password: "first password", role: "cashier", displayName: "Азиз" });
    const { context, page } = await newLaptop(browser);
    contexts.push(context);
    await signIn(page, "mudir", "admin password");

    await openSection(page, "Люди");
    const list = page.getByRole("region", { name: "Пользователи" });
    await seeText(list.locator('[data-user="timur"]'), "Ташкент");
    await list.getByRole("button", { name: "Изменить: Азиз" }).click();
    const edit = list.getByRole("form", { name: "Изменить Азиз" });
    expect(await optionsOf(edit.getByRole("combobox", { name: /Город/ }))).toEqual(["Везде", "Андижан", "Москва", "Ташкент"]);
    await choose(edit.getByRole("combobox", { name: /Город/ }), "tashkent");
    await edit.getByRole("button", { name: "Сохранить" }).click();
    await seeText(list.locator('[data-user="aziz"]'), "Ташкент");

    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await signIn(phone.page, "aziz", "first password");
    await seeText(balances(phone.page), "Остаток · Ташкент");
  }, 90_000);

  it("opens without a connection in the desk of the cashier, and books there what was entered then", async () => {
    const { signIn, operations } = await desk();
    const { context, page } = await newPhone(browser);
    contexts.push(context);
    await signIn(page, "timur", "tashkent cashier");
    await seeText(balances(page), /70,00\s\$/);
    // The first visit has to keep the app on the phone before there can be a visit without a connection.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-signed-in]:visible").first().waitFor();
    // The phone remembers whose desk this is and what it keeps: no other desk is offered, and no rubles.
    await seeText(balances(page), "Остаток · Ташкент");
    expect(await page.getByRole("group", { name: "Касса" }).count()).toBe(0);
    const form = await spend(page, "5");
    expect(await form.getByText("Рубли", { exact: true }).count()).toBe(0);
    await seeVisible(page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));
    expect(await operations()).toHaveLength(0);

    await context.setOffline(false);
    await expect.poll(() => operations(), { timeout: 20_000 }).toEqual([expect.objectContaining({ kassa: "tashkent", currency: "USD", amountMinor: 500 })]);
    await seeText(balances(page), /65,00\s\$/);
  }, 90_000);
});
