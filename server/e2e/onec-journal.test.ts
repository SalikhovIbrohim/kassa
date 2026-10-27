import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { loginAs, postJson } from "../test/helpers/http.js";
import { startFakeOneC, KEYS, type FakeOneC } from "../test/helpers/fake-onec.js";
import { startTestApp, type TestApp } from "../test/helpers/test-app.js";
import { choose, launchChromium, newLaptop, openSection, seeGone, seeText, seeVisible, selectField } from "./browser.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The admin's journal has a column «1С»: what became of each payment of a client in 1C, and what to do about it. */
describe("the column «1С» of the admin's journal", () => {
  let browser: Browser;
  let app: TestApp | undefined;
  let onec: FakeOneC | undefined;
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
    await onec?.close();
    onec = undefined;
  });

  const payment = (clientCode: string) => ({ id: randomUUID(), type: "income", amountMinor: 1_500, currency: "USD", category: "client_payment", clientCode });

  async function signedIn(started: TestApp, login: string, password: string): Promise<Page> {
    const { context, page } = await newLaptop(browser);
    contexts.push(context);
    await page.goto(started.baseUrl);
    await page.getByLabel("Логин").fill(login);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator("[data-signed-in]:visible").first().waitFor();
    return page;
  }

  it("shows the document, the reason it waits, and lets the admin give a payment up and put it back", async () => {
    const fake = await startFakeOneC();
    onec = fake;
    fake.addClient("А406", "Тимур");
    const started = await startTestApp({
      webDistDir,
      onec: { url: fake.url, user: fake.user, password: fake.password, organizationKey: KEYS.organization, kassaKey: KEYS.kassa, currencyKey: KEYS.currency, mode: "live" },
      onecQueue: { intervalMs: 40, baseBackoffSeconds: 0.05, blockedRetrySeconds: 0.2 },
    });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Мудир" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    const ivan = await loginAs(started, "ivan", "correct horse");
    for (const body of [payment("А406 Тимур"), payment("А999 Нету")]) expect((await postJson(started, "/api/operations", body, ivan)).status).toBe(201);
    expect((await postJson(started, "/api/operations", { id: randomUUID(), type: "expense", amountMinor: 700, currency: "USD", category: "fuel_road" }, ivan)).status).toBe(201);
    // The worker has had its go at both payments.
    await expect.poll(async () => (await started.query<{ status: string }>("SELECT status FROM onec_outbox ORDER BY id")).map((row) => row.status), { timeout: 20_000 }).toEqual(["written", "blocked"]);

    const page = await signedIn(started, "mudir", "admin password");
    await openSection(page, "Журнал");
    const table = page.getByRole("table", { name: "Журнал операций" });
    const row = (text: string) => table.locator("tr", { hasText: text });
    await seeVisible(table.getByRole("columnheader", { name: "1С", exact: true }));

    await seeText(row("А406").locator(".c-onec"), `Записан`);
    await seeText(row("А406").locator(".c-onec"), `ПКО №${fake.documents[0]!.Number}`);
    await seeText(row("А999").locator(".c-onec"), "Ждёт");
    await seeText(row("А999").locator(".c-onec"), "А999");
    // What does not go to 1C says nothing there.
    expect(await row("Топливо").locator(".c-onec").innerText()).toBe("");

    // Only what needs a person.
    await choose(selectField(page, "onec"), "problem");
    await seeGone(row("А406"));
    await seeVisible(row("А999"));

    // Given up, then put back once the client is in 1C: it is written.
    await row("А999").getByRole("button", { name: /Не записывать в 1С/ }).click();
    await seeText(row("А999").locator(".c-onec"), "Не записан");
    fake.addClient("А999", "Нету");
    await row("А999").getByRole("button", { name: /Повторить запись в 1С/ }).click();
    await seeText(row("А999").locator(".c-onec"), "В очереди");
    await expect.poll(() => fake.documents.length, { timeout: 20_000 }).toBe(2);
    await choose(selectField(page, "onec"), "written");
    await seeText(row("А999").locator(".c-onec"), `ПКО №${fake.documents[1]!.Number}`);

    // The owner's journal is as before: no column «1С».
    const owner = await signedIn(started, "owner", "long enough pass");
    await openSection(owner, "Журнал");
    await seeVisible(owner.getByRole("table", { name: "Журнал операций" }));
    expect(await owner.getByRole("columnheader", { name: "1С", exact: true }).count()).toBe(0);
  }, 120_000);
});
