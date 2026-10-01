import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { get, loginAs, postJson } from "../test/helpers/http.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { launchChromium, newPhone, seeGone, seeText, seeValue, seeVisible } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The cashier's phone with no connection, in a real browser against the real server: entries are
 * kept on the phone, the app opens without a connection, and everything that was kept reaches
 * the server by itself, exactly once.
 */
describe("making entries without a connection", () => {
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

  async function desk(opening: { RUB?: string } = {}) {
    const started = await startTestApp({ webDistDir });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    for (const [currency, amount] of Object.entries(opening)) await started.admin.setOpeningBalance(currency, amount);

    const phone = await newPhone(browser);
    context = phone.context;
    const page = phone.page;
    const signIn = async (login: string, password: string) => {
      await page.getByLabel("Логин").fill(login);
      await page.getByLabel("Пароль").fill(password);
      await page.getByRole("button", { name: "Войти" }).click();
      await page.getByRole("button", { name: "Выйти" }).waitFor();
    };
    await page.goto(started.baseUrl);
    await signIn("ivan", "correct horse");

    return {
      started,
      page,
      context: phone.context,
      signIn,
      banner: page.getByRole("region", { name: /ещё не дошли/ }),
      /** How many operations with this client code the server has, whoever wrote them (the owner sees all). */
      onServer: async (clientCode: string) => (await serverOperations(started, clientCode)).length,
      /** Who wrote them. */
      authorsOnServer: async (clientCode: string) =>
        (await serverOperations(started, clientCode)).map((item) => item.author.login),
    };
  }

  async function serverOperations(started: TestApp, clientCode: string) {
    const cookie = await loginAs(started, "owner", "long enough pass");
    const body = await (await get(started, "/api/operations?limit=100", cookie)).json();
    return (body.operations as Array<{ clientCode: string | null; author: { login: string } }>).filter(
      (item) => item.clientCode === clientCode,
    );
  }

  /** The first visit has to keep the app on the phone before there can be a visit without a connection. */
  async function waitUntilKeptOnThePhone(page: Page) {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  }

  async function enterIncome(page: Page, amount: string, clientCode: string) {
    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await page.locator("input[name=amount]").fill(amount);
    await page.locator("input[name=clientCode]").fill(clientCode);
    await page.getByRole("button", { name: "Записать приход" }).click();
  }

  it("keeps an entry on the phone, opens the app without a connection, and sends the entry by itself once, when the connection returns", async () => {
    const { started, page, context, banner, onServer } = await desk();
    await waitUntilKeptOnThePhone(page);

    await context.setOffline(true);
    await enterIncome(page, "777", "OFF-1");

    await seeVisible(page.getByRole("status").filter({ hasText: "Запись сохранена на телефоне" }));
    await seeText(banner, "Не отправлено: 1 запись");
    await seeValue(page.locator("input[name=amount]"), "");

    // The app is closed and opened again with no connection at all: it opens, and the entry is still there.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await seeText(banner, "Не отправлено: 1 запись");
    await seeText(page.getByRole("region", { name: "Остатки" }), "Нет связи");
    expect(await onServer("OFF-1")).toBe(0);

    await context.setOffline(false);

    await seeGone(banner);
    expect(await onServer("OFF-1")).toBe(1);
    await seeText(page.locator('[data-currency="RUB"]'), "777,00");
    // The server's own books agree.
    const cookie = await loginAs(started, "ivan", "correct horse");
    const balances = (await (await get(started, "/api/balances", cookie)).json()).balances;
    expect(balances[0]).toEqual({ currency: "RUB", amountMinor: 77_700 });
  });

  it("counts an entry once when the server saved it but its answer never came back", async () => {
    const { page, banner, onServer } = await desk();
    await page.route("**/api/operations", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch().catch(() => {});
      await route.abort("connectionreset").catch(() => {});
    });

    await enterIncome(page, "888", "OFF-2");

    await seeVisible(page.getByRole("status").filter({ hasText: "Запись сохранена на телефоне" }));
    expect(await onServer("OFF-2")).toBe(1);

    await page.unroute("**/api/operations");
    await banner.getByRole("button", { name: "Отправить сейчас" }).click();

    await seeGone(banner);
    expect(await onServer("OFF-2")).toBe(1);
  });

  it("lets an expense be entered without a connection, with the categories the phone kept", async () => {
    const { started, page, context, banner } = await desk({ RUB: "1000" });
    await waitUntilKeptOnThePhone(page);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await page.locator("input[name=amount]").fill("250");
    await page.getByText("Топливо и дорога").click();
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(banner, "Не отправлено: 1 запись");
    await context.setOffline(false);

    await seeGone(banner);
    const cookie = await loginAs(started, "ivan", "correct horse");
    const operations = (await (await get(started, "/api/operations?limit=100", cookie)).json()).operations;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ type: "expense", category: "fuel_road", amountMinor: 25_000 });
  });

  it("keeps an entry when the session has ended, asks for a sign-in, and sends it after that", async () => {
    const { started, page, context, signIn, onServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "999", "OFF-3");
    await seeText(page.getByRole("region", { name: /ещё не дошли/ }), "Не отправлено: 1 запись");
    // Meanwhile somebody ends the cashier's sessions (access revoked, then given back).
    await started.admin.revokeUser("ivan");
    await started.admin.restoreUser("ivan");

    await context.setOffline(false);

    await seeVisible(page.getByText("На телефоне ждут отправки: 1 запись"));
    expect(await onServer("OFF-3")).toBe(0);

    await signIn("ivan", "correct horse");

    await expect.poll(() => onServer("OFF-3")).toBe(1);
  });

  it("does not send an entry under another cashier's session, warns on leaving, and sends it when its author is back", async () => {
    const { page, context, banner, signIn, onServer, authorsOnServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "111", "OFF-4");
    await seeText(banner, "Не отправлено: 1 запись");
    // The connection comes back, but the server cannot be reached for entries yet.
    await page.route("**/api/operations", (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue()));
    await context.setOffline(false);

    await page.getByRole("button", { name: "Выйти" }).click();
    await seeText(page.getByRole("alertdialog"), "Они останутся на этом телефоне");
    await page.getByRole("button", { name: "Всё равно выйти" }).click();
    await page.getByRole("button", { name: "Войти" }).waitFor();
    await signIn("petr", "another good one");
    await page.unroute("**/api/operations");

    await seeText(page.getByRole("region", { name: /ещё не дошли/ }), "ждут входа другого кассира (ivan)");
    // Give the phone every chance to send it (the connection "comes back" once more): it must not.
    await context.setOffline(true);
    await context.setOffline(false);
    await page.waitForTimeout(1500);
    expect(await onServer("OFF-4")).toBe(0);

    await page.getByRole("button", { name: "Выйти" }).click();
    await page.getByRole("button", { name: "Войти" }).waitFor();
    await signIn("ivan", "correct horse");

    await expect.poll(() => onServer("OFF-4")).toBe(1);
    // Written by the cashier who made the entry, not by the one who was signed in when it went out.
    expect(await authorsOnServer("OFF-4")).toEqual(["ivan"]);
  });

  it("keeps an entry the server refuses for lack of money, with the reason, until the cashier decides", async () => {
    const { started, page, context, banner } = await desk();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await page.locator("input[name=amount]").fill("500");
    await page.getByText("Топливо и дорога").click();
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(banner, "Не отправлено: 1 запись");

    await context.setOffline(false);

    await seeText(banner, "В кассе не хватает денег");
    await seeText(banner, "Сервер не принял эти записи");

    // Money comes in (another way), and the cashier asks to try again.
    const cookie = await loginAs(started, "ivan", "correct horse");
    const income = await postJson(
      started,
      "/api/operations",
      { id: crypto.randomUUID(), type: "income", amountMinor: 100_000, currency: "RUB", clientCode: "FUND" },
      cookie,
    );
    expect(income.status).toBe(201);
    await banner.getByRole("button", { name: "Повторить" }).click();

    await seeGone(banner);
    const operations = (await (await get(started, "/api/operations?limit=100", cookie)).json()).operations;
    expect(operations.filter((item: { type: string }) => item.type === "expense")).toHaveLength(1);
  });

  it("lets the cashier give up an entry the server refused, after asking twice", async () => {
    const { started, page, context, banner } = await desk();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await page.locator("input[name=amount]").fill("500");
    await page.getByText("Топливо и дорога").click();
    await page.getByRole("button", { name: "Записать расход" }).click();
    await seeText(banner, "Не отправлено: 1 запись");
    await context.setOffline(false);
    await seeText(banner, "В кассе не хватает денег");

    await banner.getByRole("button", { name: "Убрать" }).click();
    await seeText(banner, "Точно убрать?");
    await banner.getByRole("button", { name: "Да, убрать" }).click();

    await seeGone(banner);
    const cookie = await loginAs(started, "ivan", "correct horse");
    expect((await (await get(started, "/api/operations?limit=100", cookie)).json()).operations).toEqual([]);
  });
});
