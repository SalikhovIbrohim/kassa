import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { signedLaunch } from "./helpers/telegram.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const TOKEN = "123456:TEST-token-of-the-bot";
const NOW = new Date("2026-03-05T08:30:00Z");

describe("signing in inside Telegram", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk(options: { token?: string | undefined } = { token: TOKEN }) {
    const started = await startTestApp({ telegramBotToken: options.token });
    app = started;
    started.setNow(NOW);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    return { started, ivan: await loginAs(started, "ivan", "correct horse"), petr: await loginAs(started, "petr", "another good one") };
  }

  const link = (started: TestApp, initData: string, cookie?: string) => postJson(started, "/api/telegram/link", { initData }, cookie);
  const login = (started: TestApp, initData: string) => postJson(started, "/api/telegram/login", { initData });

  it("signs in the login that a Telegram account is linked to, with a session like a password gives", async () => {
    const { started, ivan } = await desk();
    expect((await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan)).status).toBe(204);

    const response = await login(started, signedLaunch(TOKEN, 1001, { authDate: NOW }));

    expect(response.status).toBe(200);
    expect((await response.json()).user).toEqual({ login: "ivan", displayName: "Иван", role: "cashier", telegramLinked: true });
    const cookie = (response.headers.getSetCookie().find((c) => c.startsWith("kassa_session=")) ?? "").split(";")[0]!;
    expect((await (await get(started, "/api/me", cookie)).json()).user).toMatchObject({ login: "ivan", telegramLinked: true });
  });

  it("gives nothing to a Telegram account that is not linked", async () => {
    const { started } = await desk();

    const response = await login(started, signedLaunch(TOKEN, 4242, { authDate: NOW }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "telegram_not_linked" });
    expect(response.headers.getSetCookie().some((c) => c.startsWith("kassa_session="))).toBe(false);
  });

  it("turns away data that was not signed with the key of the bot, or was changed after it was signed", async () => {
    const { started, ivan } = await desk();
    await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan);
    const forged = signedLaunch("999999:another-bot", 1001, { authDate: NOW });
    const changed = signedLaunch(TOKEN, 2002, { authDate: NOW }).replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 1001 }))}`);
    const withoutHash = signedLaunch(TOKEN, 1001, { authDate: NOW }).replace(/&hash=[0-9a-f]+/, "");

    for (const initData of [forged, changed, withoutHash, "not even a query string", "hash=00"]) {
      const response = await login(started, initData);
      expect(response.status, initData).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("turns away launch data that is too old, and data from the future", async () => {
    const { started, ivan } = await desk();
    await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan);

    const old = await login(started, signedLaunch(TOKEN, 1001, { authDate: new Date(NOW.getTime() - 3601_000) }));
    const fresh = await login(started, signedLaunch(TOKEN, 1001, { authDate: new Date(NOW.getTime() - 3500_000) }));
    const future = await login(started, signedLaunch(TOKEN, 1001, { authDate: new Date(NOW.getTime() + 3_600_000) }));

    expect(old.status).toBe(401);
    expect(await old.json()).toEqual({ error: "stale_telegram_data" });
    expect(fresh.status).toBe(200);
    expect(future.status).toBe(401);
  });

  it("links an account only for somebody who is signed in, and only once for each Telegram account", async () => {
    const { started, ivan, petr } = await desk();
    const launch = signedLaunch(TOKEN, 1001, { authDate: NOW });

    expect((await link(started, launch)).status).toBe(401);
    expect((await link(started, launch, ivan)).status).toBe(204);
    const second = await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW, extra: { query_id: "other" } }), petr);

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "telegram_taken" });
    // Linking again from the same login is fine, also with another account: the login has one at a time.
    expect((await link(started, signedLaunch(TOKEN, 3003, { authDate: NOW }), ivan)).status).toBe(204);
    expect((await login(started, launch)).status).toBe(403);
    expect((await login(started, signedLaunch(TOKEN, 3003, { authDate: NOW }))).status).toBe(200);
  });

  it("refuses to link data that is not signed, and can unlink", async () => {
    const { started, ivan } = await desk();

    expect((await link(started, signedLaunch("999999:another-bot", 1001, { authDate: NOW }), ivan)).status).toBe(401);
    expect((await (await get(started, "/api/me", ivan)).json()).user.telegramLinked).toBe(false);
    await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan);
    expect((await (await get(started, "/api/me", ivan)).json()).user.telegramLinked).toBe(true);
    const removed = await fetch(`${started.baseUrl}/api/telegram/link`, { method: "DELETE", headers: { cookie: ivan } });

    expect(removed.status).toBe(204);
    expect((await (await get(started, "/api/me", ivan)).json()).user.telegramLinked).toBe(false);
    expect((await login(started, signedLaunch(TOKEN, 1001, { authDate: NOW }))).status).toBe(403);
  });

  it("does not sign in a login whose access was withdrawn", async () => {
    const { started, ivan } = await desk();
    await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan);
    await started.admin.revokeUser("ivan");

    expect((await login(started, signedLaunch(TOKEN, 1001, { authDate: NOW }))).status).toBe(403);
  });

  it("is off without the token of a bot: the password still works, and the answers say so", async () => {
    const { started, ivan } = await desk({ token: undefined });

    const response = await login(started, signedLaunch(TOKEN, 1001, { authDate: NOW }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "telegram_disabled" });
    expect((await link(started, signedLaunch(TOKEN, 1001, { authDate: NOW }), ivan)).status).toBe(404);
    expect((await get(started, "/api/me", ivan)).status).toBe(200);
  });
});
