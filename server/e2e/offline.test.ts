import { randomUUID } from "node:crypto";
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

  /** The amount field of the form that is on the screen (the other form is kept alive, hidden). */
  const amountField = (page: Page) => page.getByRole("textbox", { name: "Сумма" });

  async function enterIncome(page: Page, amount: string, clientCode: string) {
    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await amountField(page).fill(amount);
    await page.locator("input[name=clientCode]").fill(clientCode);
    await page.getByRole("button", { name: "Записать приход" }).click();
  }

  /**
   * The entry was typed and the first try to send it failed: the form says so. The banner is there earlier, as
   * soon as the entry is on the phone, so it is not the moment to let the connection come back.
   */
  const waitUntilKept = (page: Page) =>
    seeVisible(page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));

  async function enterExpense(page: Page, amount: string, category = "Топливо и дорога") {
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await amountField(page).fill(amount);
    await page.getByText(category).click();
    await page.getByRole("button", { name: "Записать расход" }).click();
  }

  it("keeps an entry on the phone, opens the app without a connection, and sends the entry by itself once, when the connection returns", async () => {
    const { started, page, context, banner, onServer } = await desk();
    await waitUntilKeptOnThePhone(page);

    await context.setOffline(true);
    await enterIncome(page, "777", "OFF-1");

    await seeVisible(page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло: Приход +777,00" }));
    await seeText(banner, "Не отправлено: 1 запись");
    // The balances do not count what is on the phone, and say so.
    await seeText(page.getByRole("region", { name: "Остатки" }), "Без учёта неотправленных записей: 1");
    await seeValue(amountField(page), "");

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

    await seeVisible(page.getByRole("status").filter({ hasText: "Сохранено на телефоне, на сервер не ушло" }));
    expect(await onServer("OFF-2")).toBe(1);

    await page.unroute("**/api/operations");
    await banner.getByRole("button", { name: "Отправить сейчас" }).click();

    await seeGone(banner);
    expect(await onServer("OFF-2")).toBe(1);
    // The form that kept the entry says that it has arrived, like for any entry that is saved.
    await seeText(page.locator(".success"), "Записано: приход");
    await seeGone(page.getByText("Сохранено на телефоне, на сервер не ушло"));
  });

  it("lets an expense be entered without a connection, with the categories the phone kept", async () => {
    const { started, page, context, banner } = await desk({ RUB: "1000" });
    await waitUntilKeptOnThePhone(page);

    await context.setOffline(true);
    await enterExpense(page, "250");
    await waitUntilKept(page);
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
    await waitUntilKept(page);
    await seeText(page.getByRole("region", { name: /ещё не дошли/ }), "Не отправлено: 1 запись");
    // Meanwhile somebody ends the cashier's sessions (access revoked, then given back).
    await started.admin.revokeUser("ivan");
    await started.admin.restoreUser("ivan");

    await context.setOffline(false);

    await seeVisible(page.getByText("На телефоне ждёт отправки: 1 запись"));
    expect(await onServer("OFF-3")).toBe(0);

    await signIn("ivan", "correct horse");

    await expect.poll(() => onServer("OFF-3")).toBe(1);
  });

  it("does not send an entry under another cashier's session, warns on leaving, and sends it when its author is back", async () => {
    const { page, context, banner, signIn, onServer, authorsOnServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "111", "OFF-4");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");
    // The connection comes back, but the server cannot be reached for entries yet.
    await page.route("**/api/operations", (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue()));
    await context.setOffline(false);

    await page.getByRole("button", { name: "Выйти" }).click();
    await seeText(page.getByRole("alertdialog"), "Она останется на этом телефоне");
    await page.getByRole("button", { name: "Всё равно выйти" }).click();
    await page.getByRole("button", { name: "Войти" }).waitFor();
    await signIn("petr", "another good one");
    await page.unroute("**/api/operations");

    await seeText(page.getByRole("region", { name: /ещё не дошли/ }), "записи другого кассира (ivan)");
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
    await enterExpense(page, "500");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");

    await context.setOffline(false);

    await seeText(banner, "В кассе не хватило денег");
    await seeText(banner, "Сервер не принял эту запись");
    // The form that made the entry says so too, and what to do.
    await seeText(page.getByRole("status").filter({ hasText: "Сервер не принял запись" }), "Что с ней делать, решите в плашке");

    // Money comes in (another way), and the cashier asks to try again.
    const cookie = await loginAs(started, "ivan", "correct horse");
    const income = await postJson(
      started,
      "/api/operations",
      { id: crypto.randomUUID(), type: "income", amountMinor: 100_000, currency: "RUB", clientCode: "FUND" },
      cookie,
    );
    expect(income.status).toBe(201);
    await banner.getByRole("button", { name: "Отправить снова" }).click();

    await seeGone(banner);
    const operations = (await (await get(started, "/api/operations?limit=100", cookie)).json()).operations;
    expect(operations.filter((item: { type: string }) => item.type === "expense")).toHaveLength(1);
  });

  it("lets the cashier delete from the phone an entry the server refused, after asking twice", async () => {
    const { started, page, context, banner } = await desk();
    await context.setOffline(true);
    await enterExpense(page, "500");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");
    await context.setOffline(false);
    await seeText(banner, "В кассе не хватило денег");

    await banner.getByRole("button", { name: "Удалить с телефона" }).click();
    await seeText(banner, "Удалить эту запись с телефона?");
    await banner.getByRole("button", { name: "Да, удалить" }).click();

    await seeGone(banner);
    const cookie = await loginAs(started, "ivan", "correct horse");
    expect((await (await get(started, "/api/operations?limit=100", cookie)).json()).operations).toEqual([]);
  });

  it("does not leave a tab on the screen of a cashier who has signed out in another tab of the same browser", async () => {
    const { started, page, context, banner, signIn, onServer, authorsOnServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "321", "TAB-1");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");
    // No tab of this browser can send entries for now; for everything else the connection is back.
    const noEntries = (route: import("playwright-core").Route) =>
      route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue();
    await context.route("**/api/operations", noEntries);
    await context.setOffline(false);

    // Another tab of the same browser (one cookie jar): ivan leaves it, petr signs in.
    const other = await context.newPage();
    await other.goto(started.baseUrl);
    await other.getByRole("button", { name: "Выйти" }).click();
    await other.getByRole("button", { name: "Всё равно выйти" }).click();
    await other.getByLabel("Логин").fill("petr");
    await other.getByLabel("Пароль").fill("another good one");
    await other.getByRole("button", { name: "Войти" }).click();
    await other.getByRole("button", { name: "Выйти" }).waitFor();

    // The first tab does not go on as ivan: it asks for a sign-in, and says what waits on the phone.
    await seeVisible(page.getByRole("button", { name: "Войти" }));
    await seeText(page.locator("form.card"), "На телефоне ждёт отправки: 1 запись");
    await context.unroute("**/api/operations", noEntries);
    await page.waitForTimeout(1500);
    expect(await onServer("TAB-1")).toBe(0);

    // The entry waits for its author, and is written by him.
    await signIn("ivan", "correct horse");
    await expect.poll(() => onServer("TAB-1")).toBe(1);
    expect(await authorsOnServer("TAB-1")).toEqual(["ivan"]);
  });

  it("does not book an entry under a session of another cashier that no screen of this tab knows about", async () => {
    const { started, page, context, banner, signIn, onServer, authorsOnServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "654", "TAB-2");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");
    // The connection comes back but entries still cannot go out (from any tab: the entries on the phone are
    // shared), while petr signs in behind this tab's back: the cookie is shared by the whole browser, and
    // nothing tells this tab.
    const noEntries = (route: import("playwright-core").Route) =>
      route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue();
    await context.route("**/api/operations", noEntries);
    await context.setOffline(false);
    const other = await context.newPage();
    await other.goto(started.baseUrl);
    await other.evaluate(async () => {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "petr", password: "another good one" }),
      });
      if (!response.ok) throw new Error(`login ${response.status}`);
    });

    await context.unroute("**/api/operations", noEntries);
    // Either the button or the phone's own next try gets there first: both end the same way.
    await banner.getByRole("button", { name: "Отправить сейчас" }).click({ timeout: 2_000 }).catch(() => {});

    // The server refuses it (it is ivan's entry, the session is petr's): it asks for a sign-in and books nothing.
    await seeText(banner, "Нужно войти заново");
    expect(await onServer("TAB-2")).toBe(0);
    await banner.getByRole("button", { name: "Войти" }).click();
    await signIn("ivan", "correct horse");
    await expect.poll(() => onServer("TAB-2")).toBe(1);
    expect(await authorsOnServer("TAB-2")).toEqual(["ivan"]);
  });

  it("does not hold the form when the server does not answer: the entry is on the phone, and goes out when the server is back", async () => {
    const { page, banner, onServer } = await desk();
    // A connection that is up and a server that never answers.
    await page.route("**/api/operations", () => {});

    await enterIncome(page, "654", "HANG-1");

    await seeVisible(page.getByRole("status").filter({ hasText: "Сервер отвечает долго" }));
    await seeText(page.getByRole("button", { name: /Записать приход|Записываем/ }), "Записать приход");
    await seeValue(amountField(page), "");
    expect(await onServer("HANG-1")).toBe(0);

    await page.unroute("**/api/operations");
    // The request that hangs is cut off after ten seconds, and the entry goes out again by itself.
    await seeGone(banner);
    expect(await onServer("HANG-1")).toBe(1);
    await seeText(page.locator(".success"), "Записано: приход");
  });

  it("does not write one entry over the other when the second form is pressed while the first is still on its way", async () => {
    const { page, onServer } = await desk({ RUB: "1000" });
    // Both forms are filled in before anything is pressed, so that the second press comes within a moment.
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await amountField(page).fill("10");
    await page.getByText("Топливо и дорога").click();
    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await amountField(page).fill("654");
    await page.locator("input[name=clientCode]").fill("BUSY-1");
    // The server holds the answer to the first entry until the test lets it go.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/operations", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });

    await page.getByRole("button", { name: "Записать приход" }).click();
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await page.getByRole("button", { name: "Записать расход" }).click();

    await seeVisible(page.getByRole("alert").filter({ hasText: "Предыдущая запись ещё отправляется" }));
    // What was typed in the expense form is still there.
    await seeValue(amountField(page), "10");
    release();
    await seeText(page.locator(".success").filter({ hasText: "Записано: приход" }), "654,00");

    await page.getByRole("button", { name: "Записать расход" }).click();

    await seeText(page.locator(".success").filter({ hasText: "Топливо и дорога" }), "10,00");
    expect(await onServer("BUSY-1")).toBe(1);
  });

  it("opens the app from the phone while the proxy answers 502 for everything, and keeps entries until the server is back", async () => {
    const { page, context, banner, onServer } = await desk();
    await waitUntilKeptOnThePhone(page);
    const down = (route: import("playwright-core").Route) =>
      route.fulfill({ status: 502, contentType: "text/plain", body: "Bad Gateway" });
    // The context sees what the service worker asks for too, which the page alone does not.
    await context.route("**/*", down);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await enterIncome(page, "135", "BAD-1");
    await seeText(banner, "Не отправлено: 1 запись");

    await context.unroute("**/*", down);
    await seeGone(banner);
    expect(await onServer("BAD-1")).toBe(1);
  });

  it("sends what waits before an entry typed now, so that money that came in earlier counts first", async () => {
    const { page, context, banner, onServer } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "100", "ORD-1");
    await waitUntilKept(page);
    await seeText(banner, "Не отправлено: 1 запись");
    // The connection is back, but the first try fails: the entry waits, and its next try is a few seconds away.
    let failed = false;
    await page.route("**/api/operations", (route) => {
      if (route.request().method() === "POST" && !failed) {
        failed = true;
        return route.abort("internetdisconnected");
      }
      return route.continue();
    });
    await context.setOffline(false);
    await page.waitForFunction(() => document.body.innerText.includes("Нет связи с сервером"));

    // An expense of 80 with the income of 100 still on the phone: the server has no money yet.
    await enterExpense(page, "80");

    await seeGone(banner);
    expect(await page.getByText("В кассе не хватает денег").count()).toBe(0);
    expect(await onServer("ORD-1")).toBe(1);
    await seeText(page.locator('[data-currency="RUB"]'), "20,00");
  });

  it("keeps a very long client code inside the screen", async () => {
    const { page, context, banner } = await desk();
    await context.setOffline(true);
    await enterIncome(page, "5", "K".repeat(60));
    await seeText(banner, "Не отправлено: 1 запись");

    await banner.getByRole("button", { name: "Показать список" }).click();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  it("keeps what is typed in the expense form while the income form is looked at", async () => {
    const { page } = await desk({ RUB: "1000" });
    await page.getByRole("button", { name: "Расход", exact: true }).click();
    await amountField(page).fill("250");
    await page.getByText("Топливо и дорога").click();

    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await seeValue(amountField(page), "");
    await page.getByRole("button", { name: "Расход", exact: true }).click();

    await seeValue(amountField(page), "250");
    expect(await page.getByRole("radio", { name: "Топливо и дорога" }).isChecked()).toBe(true);
  });

  it("starts a form with the currency of the last entry also when the server cannot be asked", async () => {
    const { page, context } = await desk();
    await waitUntilKeptOnThePhone(page);
    await page.getByRole("button", { name: "Приход", exact: true }).click();
    await page.getByRole("radio", { name: "Доллары" }).check();
    await amountField(page).fill("10");
    await page.locator("input[name=clientCode]").fill("USD-1");
    await page.getByRole("button", { name: "Записать приход" }).click();
    await seeText(page.locator(".success"), "Записано: приход");

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();

    expect(await page.getByRole("radio", { name: "Доллары" }).isChecked()).toBe(true);
  });

  /** Ivan made an entry on another device: what the server knows as the currency he worked in last. */
  async function enteredElsewhere(started: TestApp, currency: "RUB" | "USD") {
    const cookie = await loginAs(started, "ivan", "correct horse");
    const response = await postJson(
      started,
      "/api/operations",
      { id: randomUUID(), type: "income", amountMinor: 1_000, currency, clientCode: "ELSE-1" },
      cookie,
    );
    expect(response.status).toBe(201);
  }

  const holdDefaults = (context: BrowserContext) =>
    context.route("**/api/operations/defaults", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });

  it("does not change the currency under the hands of a cashier who has started typing, when the server's idea of it comes late", async () => {
    const { started, page, context } = await desk();
    await enteredElsewhere(started, "USD");
    await holdDefaults(context);
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    expect(await page.getByRole("radio", { name: "Рубли" }).isChecked()).toBe(true);

    await amountField(page).fill("250");
    await page.waitForTimeout(3_500);

    expect(await page.getByRole("radio", { name: "Рубли" }).isChecked()).toBe(true);
  });

  it("keeps the currency that the phone remembers, also when the server's last entry of the cashier was in another one", async () => {
    const { started, page } = await desk();
    await enteredElsewhere(started, "RUB");
    await page.evaluate(() => localStorage.setItem("kassa.currency", "USD"));
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await page.waitForTimeout(1_500);

    expect(await page.getByRole("radio", { name: "Доллары" }).isChecked()).toBe(true);
  });

  it("keeps the form and says what to do when the session has ended and the phone cannot keep the entry", async () => {
    const { page, context } = await desk();
    // A phone whose storage refuses to open (full, private mode); the server says the session has ended.
    await context.addInitScript(() => {
      IDBFactory.prototype.open = function () {
        throw new DOMException("denied", "SecurityError");
      };
    });
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Выйти" }).waitFor();
    await page.route("**/api/operations", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) })
        : route.continue(),
    );

    await enterIncome(page, "4321", "B5-1");

    await seeVisible(page.getByRole("alert").filter({ hasText: "Нужно войти заново, а на телефоне запись сохранить не удалось" }));
    await seeValue(amountField(page), "4321");
    expect(await page.getByLabel("Логин").count()).toBe(0);
  });
});
