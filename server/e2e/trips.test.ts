import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { parseKassas } from "../src/kassa.js";
import { parseWarehouses } from "../src/warehouses.js";
import { get, loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newLaptop, newPhone, openSection, optionsOf, seeGone, seeText, seeValue, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The spaces a Russian number is written with are not the one of the keyboard: read as plain ones. */
const plain = (text: string) => text.replace(/[  ]/g, " ");

/** «Сборные грузы»: the trips and their waybills on the screen, and the debt of a client in the cash desk. */
describe("the trips on the screen", () => {
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

  /** A business that keeps trips: three desks of dollars, codes of digits, three warehouses, two clients with a price. */
  async function business() {
    const started = await startTestApp({
      webDistDir,
      kassas: parseKassas("moscow:USD,andijan:USD,tashkent:USD"),
      clientCodes: "digits",
      warehouses: parseWarehouses("andijan,kokand,tashkent"),
    });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const mudir = await loginAs(started, "mudir", "admin password");
    expect((await postJson(started, "/api/admin/users", { login: "qodir", displayName: "Қодир", password: "warehouse pass", role: "warehouse", city: "kokand" }, mudir)).status).toBe(201);
    const loaded = await postJson(started, "/api/admin/clients/import", { clients: [{ code: "132", name: "Иброхим", priceMilli: 1500 }, { code: "70", name: "Лочин", priceMilli: 1550 }, { code: "3", name: "Рахимберди" }] }, mudir);
    expect(await loaded.json()).toEqual({ added: 3, skipped: 0 });
    return { started, mudir };
  }

  const tripPage = (page: Page, number: number) => page.locator(`[data-trip-page="${number}"]:visible`);
  const cargoForm = (page: Page) => page.getByRole("form", { name: "Добавить груз" }).locator("visible=true").first();

  it("are made, loaded and marked arrived on a laptop, and from then on the client owes in «Клиенты» and in the cash desk", async () => {
    const { started, mudir } = await business();
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    const page = laptop.page;
    await signIn(page, started, "mudir", "admin password");
    await openSection(page, "Сборные грузы");
    await seeText(page.locator("section[aria-label=Рейсы]:visible"), "Рейсов пока нет");

    // A new trip: the next number is offered, another may be typed.
    await page.getByRole("button", { name: "+ Новый рейс", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новый рейс" });
    await seeValue(dialog.locator("input[name=number]"), "1");
    await dialog.locator("input[name=number]").fill("190");
    await dialog.locator("input[name=driverName]").fill("Жахонгир");
    await dialog.locator("input[name=departureDay]").fill("2026-07-31");
    await dialog.getByRole("button", { name: "Создать рейс" }).click();
    await seeVisible(tripPage(page, 190));
    await seeText(tripPage(page, 190), "Грузится");

    // A line of cargo: the client by the code, the price the client's own, the sum worked out as the weight is typed.
    const form = cargoForm(page);
    await form.locator("input[name=clientCode]").fill("132");
    await seeValue(form.locator("input[name=price]"), "1,5");
    await seeText(form.locator("[data-client-debt]"), "Иброхим: долга нет");
    await form.locator("input[name=sender]").fill("Абдурашид");
    await form.locator("input[name=item]").fill("Трусы мужская");
    await form.locator("input[name=brand]").fill("вучт");
    await form.locator("input[name=bags]").fill("120");
    await form.locator("input[name=perBag]").fill("300");
    await form.locator("input[name=weight]").fill("3686,5");
    expect(plain(await form.locator("output[name=amount]").innerText())).toBe("5 529,75 $");
    await form.getByRole("button", { name: "Добавить строку" }).click();
    const table = page.locator("table[data-cargo]:visible");
    await seeText(table, "Трусы мужская");
    const row = plain(await table.locator("tbody tr").first().innerText());
    expect(row).toContain("Андижан");
    expect(row).toContain("Иброхим 132");
    // The pieces in all are what the bags come to, since nobody typed another number.
    expect(row).toContain("36 000");
    expect(row).toContain("3 686,5");
    expect(row).toContain("5 529,75 $");
    // The client and the sender stay for the next line; the goods are emptied.
    await seeValue(form.locator("input[name=clientCode]"), "132");
    await seeValue(form.locator("input[name=sender]"), "Абдурашид");
    await seeValue(form.locator("input[name=item]"), "");
    await seeValue(form.locator("input[name=weight]"), "");

    // A client without a price of their own: the line has to say one.
    await form.locator("input[name=clientCode]").fill("3 Рахимберди");
    await form.locator("input[name=price]").fill("");
    await form.locator("input[name=weight]").fill("204,82");
    await form.getByRole("button", { name: "Добавить строку" }).click();
    await seeText(form.locator("[role=alert]"), "нет своей цены");
    await form.locator("input[name=price]").fill("1,5");
    await form.getByRole("button", { name: "Добавить строку" }).click();
    await expect.poll(() => table.locator("tbody tr").count()).toBe(2);

    // The second line is corrected and then taken off.
    await page.getByRole("button", { name: "Изменить груз: Рахимберди 3" }).locator("visible=true").first().click();
    const edit = page.getByRole("dialog", { name: "Изменить груз" });
    await seeValue(edit.locator("input[name=weight]"), "204,82");
    await edit.locator("input[name=weight]").fill("300");
    await edit.getByRole("button", { name: "Сохранить" }).click();
    await seeGone(page.getByRole("dialog", { name: "Изменить груз" }));
    await expect.poll(async () => plain(await table.innerText())).toContain("450,00 $");
    await page.getByRole("button", { name: "Удалить груз: Рахимберди 3" }).locator("visible=true").first().click();
    await page.getByRole("dialog", { name: "Удалить строку груза?" }).getByRole("button", { name: "Да, удалить" }).click();
    await expect.poll(() => table.locator("tbody tr").count()).toBe(1);

    // On its way, then arrived: from the day of the arrival the cargo is owed.
    await page.getByRole("button", { name: "Фура выехала →" }).click();
    await seeText(tripPage(page, 190), "В пути");
    await page.getByRole("button", { name: "Рейс прибыл", exact: true }).click();
    const arrival = page.getByRole("dialog", { name: "Прибытие рейса" });
    await arrival.locator("input[name=arrivalDay]").fill("2026-08-16");
    await arrival.getByRole("button", { name: "Подтвердить прибытие" }).click();
    await seeText(tripPage(page, 190), "прибыл 16.08.2026");
    const totals = plain(await page.locator("table[data-client-totals]:visible").innerText());
    expect(totals).toContain("Иброхим");
    expect(totals.match(/5 529,75 \$/g)).toHaveLength(2); // what is on the truck, and what the client owes now
    expect(plain(await page.locator("[data-trip-totals]:visible").innerText())).toContain("Сумма в фуре");

    // The list of the trips, and the same debt in «Клиенты».
    await page.getByRole("button", { name: "Все рейсы" }).click();
    const listed = plain(await page.locator("table[data-trips]:visible tbody tr").first().innerText());
    expect(listed).toContain("190");
    expect(listed).toContain("Жахонгир");
    expect(listed).toContain("31.07.2026");
    expect(listed).toContain("16.08.2026");
    expect(listed).toContain("Прибыл");
    expect(listed).toContain("5 529,75 $");
    await openSection(page, "Клиенты");
    const client = page.locator('[data-client="132"]:visible');
    await seeText(client, "долг");
    expect(plain(await client.innerText())).toContain("долг 5 529,75 $");
    expect(plain(await client.innerText())).toContain("1,5 $/кг");
    expect(plain(await page.locator("[data-debts]:visible").innerText())).toContain("Должны всего: 5 529,75 $");

    // The cashier takes a payment on a phone: the form says the debt under the code, before and after.
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    await signIn(phone.page, started, "ivan", "correct horse");
    const income = phone.page.locator("form:visible").first();
    await income.locator("input[name=clientCode]").fill("132");
    await seeText(income.locator("[data-client-debt]"), "Иброхим: долг");
    expect(plain(await income.locator("[data-client-debt]").innerText())).toBe("Иброхим: долг 5 529,75 $");
    await income.getByRole("textbox", { name: "Сумма" }).fill("3000");
    await income.getByRole("button", { name: "Записать приход" }).click();
    await seeText(phone.page.locator(".success:visible"), /Записано: приход/);
    await income.locator("input[name=clientCode]").fill("132 Иброхим");
    await expect.poll(async () => plain(await income.locator("[data-client-debt]").innerText().catch(() => ""))).toBe("Иброхим: долг 2 529,75 $");
    // A cashier has no «Сборные грузы»: the debt of the client is what they need of it.
    expect(await phone.page.getByRole("tab", { name: "Грузы" }).count()).toBe(0);

    // The same number on the trip, read again.
    const detail = (await (await get(started, "/api/trips/190", mudir)).json()) as { clients: Array<{ code: string; debtMinor: number }> };
    expect(detail.clients).toMatchObject([{ code: "132", debtMinor: 252_975 }]);
  }, 180_000);

  it("give the keeper of a warehouse the trips alone, with the cargo of their own warehouse to write", async () => {
    const { started, mudir } = await business();
    expect((await postJson(started, "/api/trips", { number: 191, driverName: "Бахром" }, mudir)).status).toBe(201);
    const phone = await newPhone(browser);
    contexts.push(phone.context);
    const page = phone.page;
    await signIn(page, started, "qodir", "warehouse pass");

    // Two buttons on the bar: the trips and «Настройки». Nothing of the cash.
    const bar = page.getByRole("tablist", { name: "Основные разделы" });
    expect(await bar.getByRole("tab").allInnerTexts()).toEqual(["Грузы", "Настройки"]);
    await page.locator('[data-trip-card="191"]:visible').click();
    await seeVisible(tripPage(page, 191));

    const form = cargoForm(page);
    // The warehouse is theirs: nothing to choose.
    await seeValue(form.locator("input[name=warehouse]"), "Коканд");
    await form.locator("input[name=clientCode]").fill("70");
    await seeValue(form.locator("input[name=price]"), "1,55");
    await form.locator("input[name=weight]").fill("1075");
    await form.getByRole("button", { name: "Добавить строку" }).click();
    const card = page.locator("[data-cargo-card]:visible").first();
    await seeText(card, "Лочин");
    expect(plain(await card.innerText())).toContain("1 666,25 $");
    expect(plain(await card.innerText())).toContain("Коканд");
    // What the cash desk spent on the trip is not theirs to see.
    expect(plain(await page.locator("[data-trip-totals]:visible").innerText())).not.toContain("Расходы рейса");
    // «Настройки» name their warehouse, where a cashier's cash desk would be.
    await bar.getByRole("tab", { name: "Настройки", exact: true }).click();
    await seeText(page.locator("[data-section=settings]"), "Завсклад · Коканд · qodir");
    expect(await page.getByText("Только своя касса").count()).toBe(0);
  }, 120_000);

  it("are no part of the app where the settings name no warehouse", async () => {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    const laptop = await newLaptop(browser);
    contexts.push(laptop.context);
    await signIn(laptop.page, started, "mudir", "admin password");
    const menu = laptop.page.getByRole("navigation", { name: "Разделы" });
    await seeVisible(menu.getByRole("button", { name: "Клиенты", exact: true }));
    expect(await menu.getByRole("button", { name: "Сборные грузы" }).count()).toBe(0);
    // And a person has no role of a keeper to be given.
    await openSection(laptop.page, "Люди");
    await laptop.page.getByRole("button", { name: "+ Новый", exact: true }).click();
    const dialog = laptop.page.getByRole("dialog", { name: "Новый пользователь" });
    expect(await optionsOf(dialog.locator("[data-slot=select-trigger][data-name=role]"))).toEqual(["Кассир", "Главный кассир", "Смотрящий", "Админ"]);
  }, 120_000);
});
