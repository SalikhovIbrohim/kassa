import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { get, loginAs } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The cashier's shift on the phone, in a real browser against the real server. */
describe("shifts on the cashier's screen", () => {
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
      await phone.page.getByRole("button", { name: "Выйти" }).waitFor();
      return phone;
    };
    const ivan = await phoneOf("ivan", "correct horse");
    const ownerCookie = await loginAs(started, "owner", "long enough pass");
    /** What the owner sees on the server: the operations with their shift. */
    const serverOperations = async () =>
      ((await (await get(started, "/api/operations?from=2000-01-01&to=2100-01-01&limit=100", ownerCookie)).json()).operations as Array<{
        clientCode: string | null;
        shiftId: string | null;
      }>);
    return { started, ivan, phoneOf, serverOperations, ownerCookie };
  }

  const bar = (page: Page) => page.getByRole("region", { name: "Смена", exact: true });
  const amountField = (page: Page) => page.getByRole("textbox", { name: "Сумма" });

  async function enterIncome(page: Page, amount: string, clientCode: string) {
    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await amountField(page).fill(amount);
    await page.locator("input[name=clientCode]").fill(clientCode);
    await page.getByRole("button", { name: "Записать приход" }).click();
  }

  it("shows that no shift is open, opens one, and says since when and with what balances", async () => {
    const { ivan } = await desk();
    await seeText(bar(ivan.page), "Смена не открыта");

    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();

    await seeText(bar(ivan.page), "Смена открыта");
    await expandShift(ivan.page);
    // The thousands are separated by a no-break space, which `\s` covers.
    await seeText(bar(ivan.page), /Остаток на начало: 1\s000,00\s₽ · 50,00\s\$/);
    expect(await ivan.page.getByRole("button", { name: "Открыть смену" }).count()).toBe(0);
  }, 90_000);

  it("puts what is entered into the shift, and starts the journal with the shift's operations", async () => {
    const { ivan, serverOperations } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");

    await enterIncome(ivan.page, "654", "SH-1");
    await seeText(ivan.page.locator(".success"), "Записано: приход");
    await ivan.page.getByRole("button", { name: "Журнал", exact: true }).click();

    await seeText(ivan.page.getByRole("table", { name: "Журнал операций" }), "SH-1");
    expect(await ivan.page.getByRole("button", { name: "Смена", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await seeText(ivan.page.locator(".journal .period"), "Операции текущей смены");
    const [saved] = await serverOperations();
    expect(saved).toMatchObject({ clientCode: "SH-1" });
    expect(saved!.shiftId).not.toBeNull();

    await ivan.page.getByRole("button", { name: "День", exact: true }).click();
    await seeVisible(ivan.page.getByRole("textbox", { name: "День" }).or(ivan.page.locator("input[name=day]")));
    await seeText(ivan.page.getByRole("table", { name: "Журнал операций" }), "SH-1");
  }, 90_000);

  it("puts an entry made without a connection into the shift that was open on the phone", async () => {
    const { ivan, serverOperations } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");
    await ivan.page.evaluate(() => navigator.serviceWorker.ready);
    await ivan.page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await ivan.context.setOffline(true);
    await enterIncome(ivan.page, "321", "SH-OFF");
    await seeVisible(ivan.page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));
    expect((await serverOperations()).some((item) => item.clientCode === "SH-OFF")).toBe(false);
    await ivan.context.setOffline(false);

    await seeGone(ivan.page.getByRole("region", { name: /ещё не дошли/ }));
    const [arrived] = (await serverOperations()).filter((item) => item.clientCode === "SH-OFF");
    expect(arrived).toBeDefined();
    expect(arrived!.shiftId).not.toBeNull();
  }, 90_000);

  it("tells another cashier whose shift is open, and offers no second one", async () => {
    const { ivan, phoneOf } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");

    const petr = await phoneOf("petr", "another good one");

    await seeText(bar(petr.page), "Открыта смена кассира Иван");
    expect(await petr.page.getByRole("button", { name: "Открыть смену" }).count()).toBe(0);
  }, 90_000);

  /** The details of the open shift are folded under its line. */
  const expandShift = (page: Page) => bar(page).getByRole("button", { name: /Смена открыта/ }).click();

  const countField = (page: Page, currency: "RUB" | "USD") => page.locator(`input[name=count-${currency}]`);

  async function closeWith(page: Page, rub: string, usd: string) {
    await expandShift(page);
    await page.getByRole("button", { name: "Закрыть смену" }).click();
    await countField(page, "RUB").fill(rub);
    await countField(page, "USD").fill(usd);
    await page.getByRole("button", { name: "Закрыть смену" }).last().click();
  }

  it("closes the shift with the count of the cash and says how it came out, and the books say what was counted", async () => {
    const { ivan } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");
    await enterIncome(ivan.page, "654", "SH-CLOSE");
    await seeText(ivan.page.locator(".success"), "Записано: приход");

    await closeWith(ivan.page, "1640", "50");

    // The books said 1 654,00 (1 000,00 opening and 654,00 in): the cash desk was 14,00 short.
    await seeText(bar(ivan.page), "Смена закрыта");
    await seeText(bar(ivan.page), /Рубли: по книге 1\s654,00\s₽, насчитано 1\s640,00\s₽\. Недостача 14,00\s₽\./);
    await seeText(bar(ivan.page), /Доллары: по книге 50,00\s\$, насчитано 50,00\s\$\. Сошлось\./);
    await seeText(ivan.page.getByRole("region", { name: "Остатки" }), /1\s640,00\s₽/);
    await seeVisible(ivan.page.getByRole("button", { name: "Открыть смену" }));
  }, 90_000);

  it("asks for a count of both currencies, and takes zero as a count", async () => {
    const { ivan } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");
    await expandShift(ivan.page);
    await ivan.page.getByRole("button", { name: "Закрыть смену" }).click();

    await countField(ivan.page, "RUB").fill("1000");
    await ivan.page.getByRole("button", { name: "Закрыть смену" }).last().click();
    await seeVisible(ivan.page.getByRole("alert").filter({ hasText: "Введите, сколько насчитали, по каждой валюте" }));

    await countField(ivan.page, "USD").fill("0");
    await ivan.page.getByRole("button", { name: "Закрыть смену" }).last().click();
    await seeText(bar(ivan.page), /Доллары: по книге 50,00\s\$, насчитано 0,00\s\$\. Недостача 50,00\s\$\./);
  }, 90_000);

  it("shows the owner the shift with its difference, in the list of shifts and in the totals", async () => {
    const { ivan, phoneOf } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");
    await closeWith(ivan.page, "990", "50");
    await seeText(bar(ivan.page), "Смена закрыта");

    const owner = await phoneOf("owner", "long enough pass");
    await owner.page.getByRole("button", { name: "Смены", exact: true }).click();

    const card = owner.page.locator(".shift-card").first();
    await seeText(card, "Иван");
    await seeText(card.locator('[data-currency="RUB"]'), /по книге 1\s000,00\s₽, насчитано 990,00\s₽/);
    await seeText(card.locator('[data-currency="RUB"] [data-difference]'), /−10,00\s₽/);
    await seeText(card.locator('[data-currency="USD"] [data-difference]'), "сошлось");

    await owner.page.getByRole("button", { name: "Итоги", exact: true }).click();
    await seeText(owner.page.locator('[data-total="difference"]').first(), /−10,00\s₽/);
    await seeText(owner.page.locator('[data-total="closing"]').first(), /990,00\s₽/);
  }, 90_000);

  it("does not close the shift while an entry waits on the phone", async () => {
    const { ivan } = await desk();
    await ivan.page.getByRole("button", { name: "Открыть смену" }).click();
    await seeText(bar(ivan.page), "Смена открыта");
    await ivan.page.evaluate(() => navigator.serviceWorker.ready);
    await ivan.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await ivan.context.setOffline(true);
    await enterIncome(ivan.page, "100", "SH-WAIT");
    await seeVisible(ivan.page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));

    await expandShift(ivan.page);
    await ivan.page.getByRole("button", { name: "Закрыть смену" }).click();

    await seeVisible(ivan.page.getByRole("alert").filter({ hasText: "ждёт 1 запись" }));
    expect(await ivan.page.getByRole("button", { name: "Закрыть смену" }).last().isDisabled()).toBe(true);
  }, 90_000);
});
