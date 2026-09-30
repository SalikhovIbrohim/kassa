import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson, sessionSetCookie } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const DAY_SECONDS = 24 * 60 * 60;
const START = new Date("2026-01-10T09:00:00Z");

function daysAfter(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_SECONDS * 1000);
}

describe("login", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("logs a cashier in and keeps the session in a long-lived HttpOnly cookie", async () => {
    app = await startTestApp();
    await app.admin.createUser({
      login: "ivan",
      password: "correct horse",
      role: "cashier",
      displayName: "Иван",
    });

    const response = await postJson(app, "/api/login", {
      login: "ivan",
      password: "correct horse",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { login: "ivan", displayName: "Иван", role: "cashier" },
    });
    const cookie = sessionSetCookie(response);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain(`Max-Age=${90 * DAY_SECONDS}`);
  });

  it("tells a logged-in user who they are", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    const cookie = await loginAs(app, "ivan", "correct horse");

    const response = await get(app, "/api/me", cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { login: "ivan", displayName: "Иван", role: "cashier" },
    });
  });

  it("rejects a request without a session", async () => {
    app = await startTestApp();

    const response = await get(app, "/api/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a request with a session cookie that was never issued", async () => {
    app = await startTestApp();

    const response = await get(app, "/api/me", "kassa_session=not-a-real-token");

    expect(response.status).toBe(401);
  });

  it("refuses a wrong password and sets no session", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    const response = await postJson(app, "/api/login", { login: "ivan", password: "wrong horse" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
    expect(sessionSetCookie(response)).toBeUndefined();
  });

  it("gives the same answer for an unknown login as for a wrong password", async () => {
    app = await startTestApp();

    const response = await postJson(app, "/api/login", { login: "nobody", password: "whatever12" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("accepts the login in any letter case and ignores surrounding spaces", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    const response = await postJson(app, "/api/login", { login: "  Ivan ", password: "correct horse" });

    expect(response.status).toBe(200);
  });

  it("does not ignore case or spaces in the password", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "Correct Horse", role: "cashier" });

    const lowerCase = await postJson(app, "/api/login", { login: "ivan", password: "correct horse" });
    const padded = await postJson(app, "/api/login", { login: "ivan", password: " Correct Horse " });

    expect(lowerCase.status).toBe(401);
    expect(padded.status).toBe(401);
  });

  it("rejects a login request with a malformed body", async () => {
    app = await startTestApp();

    const missingPassword = await postJson(app, "/api/login", { login: "ivan" });
    const wrongTypes = await postJson(app, "/api/login", { login: 1, password: ["x"] });

    expect(missingPassword.status).toBe(400);
    expect(wrongTypes.status).toBe(400);
  });

  it("rejects a login with a NUL character instead of failing inside the database", async () => {
    app = await startTestApp();

    const response = await postJson(app, "/api/login", { login: "iv\u0000an", password: "whatever12" });

    expect(response.status).toBe(400);
  });

  it("ends the session on logout, so the old cookie stops working", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const cookie = await loginAs(app, "ivan", "correct horse");

    const logout = await postJson(app, "/api/logout", {}, cookie);
    const after = await get(app, "/api/me", cookie);

    expect(logout.status).toBe(204);
    expect(after.status).toBe(401);
  });

  it("logs out only the device that asked, not the user's other devices", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const phone = await loginAs(app, "ivan", "correct horse");
    const laptop = await loginAs(app, "ivan", "correct horse");

    await postJson(app, "/api/logout", {}, phone);

    expect((await get(app, "/api/me", phone)).status).toBe(401);
    expect((await get(app, "/api/me", laptop)).status).toBe(200);
  });

  it("answers logout without a session with success too", async () => {
    app = await startTestApp();

    const response = await postJson(app, "/api/logout", {});

    expect(response.status).toBe(204);
  });

  it("refuses to log in a user whose access was revoked", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    await app.admin.revokeUser("ivan");

    const response = await postJson(app, "/api/login", { login: "ivan", password: "correct horse" });

    expect(response.status).toBe(401);
    expect(sessionSetCookie(response)).toBeUndefined();
  });

  it("ends every session of a user the moment access is revoked", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const phone = await loginAs(app, "ivan", "correct horse");
    const laptop = await loginAs(app, "ivan", "correct horse");

    await app.admin.revokeUser("ivan");

    expect((await get(app, "/api/me", phone)).status).toBe(401);
    expect((await get(app, "/api/me", laptop)).status).toBe(401);
  });

  it("lets a restored user log in again, with a fresh session", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const before = await loginAs(app, "ivan", "correct horse");
    await app.admin.revokeUser("ivan");
    await app.admin.restoreUser("ivan");

    const oldSession = await get(app, "/api/me", before);
    const newSession = await loginAs(app, "ivan", "correct horse");

    expect(oldSession.status).toBe(401);
    expect((await get(app, "/api/me", newSession)).status).toBe(200);
  });

  it("after a password reset the old password fails and the new one works", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    await app.admin.resetPassword("ivan", "battery staple");

    const oldPassword = await postJson(app, "/api/login", { login: "ivan", password: "correct horse" });
    const newPassword = await postJson(app, "/api/login", { login: "ivan", password: "battery staple" });
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);
  });

  it("ends existing sessions on a password reset, as after a lost phone", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const stolenPhone = await loginAs(app, "ivan", "correct horse");

    await app.admin.resetPassword("ivan", "battery staple");

    expect((await get(app, "/api/me", stolenPhone)).status).toBe(401);
  });

  describe("session lifetime", () => {
    async function loggedInCashier() {
      const started = await startTestApp();
      started.setNow(START);
      await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
      const cookie = await loginAs(started, "ivan", "correct horse");
      return { started, cookie };
    }

    it("stays valid for the whole 90 days", async () => {
      const { started, cookie } = await loggedInCashier();
      app = started;

      started.setNow(daysAfter(START, 89));

      expect((await get(started, "/api/me", cookie)).status).toBe(200);
    });

    it("expires after 90 days without use", async () => {
      const { started, cookie } = await loggedInCashier();
      app = started;

      started.setNow(daysAfter(START, 91));

      expect((await get(started, "/api/me", cookie)).status).toBe(401);
    });

    it("keeps going for someone who keeps using the app", async () => {
      const { started, cookie } = await loggedInCashier();
      app = started;

      started.setNow(daysAfter(START, 60));
      await get(started, "/api/me", cookie);
      started.setNow(daysAfter(START, 120));
      const stillIn = await get(started, "/api/me", cookie);
      started.setNow(daysAfter(START, 215));
      const gone = await get(started, "/api/me", cookie);

      expect(stillIn.status).toBe(200);
      expect(gone.status).toBe(401);
    });

    it("keeps an active user logged in even when sessions are configured to last one day", async () => {
      app = await startTestApp({ sessionDays: 1 });
      app.setNow(START);
      await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
      const cookie = await loginAs(app, "ivan", "correct horse");

      app.setNow(new Date(START.getTime() + 7 * 60 * 60 * 1000));
      await get(app, "/api/me", cookie);
      app.setNow(new Date(START.getTime() + 30 * 60 * 60 * 1000));

      expect((await get(app, "/api/me", cookie)).status).toBe(200);
    });

    it("forgets sessions that have expired, so the table does not grow forever", async () => {
      app = await startTestApp();
      app.setNow(START);
      await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
      await loginAs(app, "ivan", "correct horse");
      await loginAs(app, "ivan", "correct horse");

      app.setNow(daysAfter(START, 91));
      await loginAs(app, "ivan", "correct horse");

      const stored = await app.storedCredentialsAsText();
      expect(stored.match(/"token_hash"/g)).toHaveLength(1);
    });

    it("renews the cookie when it extends the session, at most once a day", async () => {
      const { started, cookie } = await loggedInCashier();
      app = started;

      started.setNow(daysAfter(START, 1));
      const extended = await get(started, "/api/me", cookie);
      started.setNow(new Date(daysAfter(START, 1).getTime() + 60 * 60 * 1000));
      const tooSoon = await get(started, "/api/me", cookie);

      expect(sessionSetCookie(extended)).toContain(`Max-Age=${90 * DAY_SECONDS}`);
      expect(sessionSetCookie(tooSoon)).toBeUndefined();
    });
  });

  it("keeps sessions across a server restart", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const cookie = await loginAs(app, "ivan", "correct horse");

    await app.restart();

    expect((await get(app, "/api/me", cookie)).status).toBe(200);
  });

  it("never stores a password or a session token in the clear", async () => {
    app = await startTestApp();
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const cookie = await loginAs(app, "ivan", "correct horse");
    const token = cookie.split("=")[1]!;

    const stored = await app.storedCredentialsAsText();

    expect(stored).toContain("ivan");
    expect(stored).not.toContain("correct horse");
    expect(stored).not.toContain(token);
  });

  it("marks the session cookie Secure when the server is configured for HTTPS", async () => {
    app = await startTestApp({ secureCookies: true });
    await app.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });

    const response = await postJson(app, "/api/login", { login: "ivan", password: "correct horse" });

    expect(sessionSetCookie(response)).toMatch(/;\s*Secure/i);
  });

  it("forbids caching of API answers", async () => {
    app = await startTestApp();

    const health = await get(app, "/api/health");
    const me = await get(app, "/api/me");
    const withQuery = await get(app, "/api?x=1");

    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(withQuery.headers.get("cache-control")).toBe("no-store");
  });
});
