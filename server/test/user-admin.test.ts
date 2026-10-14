import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, patchJson, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

type User = { id: string; login: string; displayName: string; role: string; active: boolean; hasEntries: boolean };

/** The admin keeps the accounts from the screen: adds, gives roles, renames, sets passwords, blocks and deletes. */
describe("the accounts, kept by the admin", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk() {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "mudir", password: "admin password", role: "admin", displayName: "Админ" });
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    return {
      started,
      mudir: await loginAs(started, "mudir", "admin password"),
      ivan: await loginAs(started, "ivan", "correct horse"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  async function users(started: TestApp, cookie: string): Promise<User[]> {
    return ((await (await get(started, "/api/admin/users", cookie)).json()) as { users: User[] }).users;
  }
  const idOf = async (started: TestApp, cookie: string, login: string) => (await users(started, cookie)).find((user) => user.login === login)!.id;

  it("is for the admin only", async () => {
    const { started, ivan, owner } = await desk();
    for (const cookie of [ivan, owner]) {
      expect((await get(started, "/api/admin/users", cookie)).status).toBe(403);
      expect((await postJson(started, "/api/admin/users", { login: "x1", password: "long enough", role: "cashier" }, cookie)).status).toBe(403);
    }
    expect((await get(started, "/api/admin/users")).status).toBe(401);
  });

  it("lists the accounts without their passwords", async () => {
    const { started, mudir } = await desk();
    const list = await users(started, mudir);
    expect(list.map((user) => user.login).sort()).toEqual(["ivan", "mudir", "owner"]);
    expect(list.find((user) => user.login === "ivan")).toMatchObject({ displayName: "Иван", role: "cashier", active: true, hasEntries: false });
    expect(JSON.stringify(list)).not.toMatch(/hash|password/i);
  });

  it("adds an account that can log in, and refuses a taken login, a bad login and a short password", async () => {
    const { started, mudir } = await desk();
    const made = await postJson(started, "/api/admin/users", { login: "aziz", displayName: "Азиз", password: "new password", role: "cashier" }, mudir);
    expect(made.status).toBe(201);
    expect((await made.json()).user).toMatchObject({ login: "aziz", displayName: "Азиз", role: "cashier", active: true });
    await loginAs(started, "aziz", "new password");

    expect((await postJson(started, "/api/admin/users", { login: "AZIZ", password: "new password", role: "cashier" }, mudir)).status).toBe(409);
    const badLogin = await postJson(started, "/api/admin/users", { login: "a b", password: "new password", role: "cashier" }, mudir);
    expect([badLogin.status, (await badLogin.json()).error]).toEqual([400, "bad_login"]);
    const short = await postJson(started, "/api/admin/users", { login: "bek", password: "short", role: "cashier" }, mudir);
    expect([short.status, (await short.json()).error]).toEqual([400, "bad_password"]);
    expect((await postJson(started, "/api/admin/users", { login: "bek", password: "new password", role: "boss" }, mudir)).status).toBe(400);
  });

  it("changes the role, the login and the name; the new login is the one to log in with", async () => {
    const { started, mudir, ivan } = await desk();
    const id = await idOf(started, mudir, "ivan");
    const changed = await patchJson(started, `/api/admin/users/${id}`, { login: "ivan2", displayName: "Иван П.", role: "admin" }, mudir);
    expect(changed.status).toBe(200);
    expect((await changed.json()).user).toMatchObject({ login: "ivan2", displayName: "Иван П.", role: "admin" });
    // The role is read with the session: the open session is an admin's now.
    expect((await get(started, "/api/admin/users", ivan)).status).toBe(200);
    await loginAs(started, "ivan2", "correct horse");

    expect((await patchJson(started, `/api/admin/users/${id}`, { login: "owner" }, mudir)).status).toBe(409);
    expect((await patchJson(started, `/api/admin/users/${randomUUID()}`, { displayName: "Никто" }, mudir)).status).toBe(404);
  });

  it("keeps the city of a person, set when added or later, and taken away", async () => {
    const { started, mudir } = await desk();
    const made = await postJson(started, "/api/admin/users", { login: "rustam", displayName: "Рустам", password: "new password", role: "cashier", city: "andijan" }, mudir);
    expect((await made.json()).user).toMatchObject({ city: "andijan" });
    const id = await idOf(started, mudir, "ivan");
    expect((await users(started, mudir)).find((user) => user.login === "ivan")).toMatchObject({ city: null });
    expect((await (await patchJson(started, `/api/admin/users/${id}`, { city: "moscow" }, mudir)).json()).user).toMatchObject({ city: "moscow" });
    expect((await (await patchJson(started, `/api/admin/users/${id}`, { displayName: "Иван П." }, mudir)).json()).user).toMatchObject({ city: "moscow" });
    expect((await (await patchJson(started, `/api/admin/users/${id}`, { city: null }, mudir)).json()).user).toMatchObject({ city: null });
    expect((await patchJson(started, `/api/admin/users/${id}`, { city: "tashkent" }, mudir)).status).toBe(400);
  });

  it("sets a new password and ends the sessions of that person", async () => {
    const { started, mudir, ivan } = await desk();
    const id = await idOf(started, mudir, "ivan");
    expect((await patchJson(started, `/api/admin/users/${id}`, { password: "brand new pass" }, mudir)).status).toBe(200);
    expect((await get(started, "/api/me", ivan)).status).toBe(401);
    await loginAs(started, "ivan", "brand new pass");
    expect((await postJson(started, "/api/login", { login: "ivan", password: "correct horse" })).status).toBe(401);
  });

  it("blocks and unblocks: a blocked person is logged out and cannot log in", async () => {
    const { started, mudir, ivan } = await desk();
    const id = await idOf(started, mudir, "ivan");
    expect((await patchJson(started, `/api/admin/users/${id}`, { active: false }, mudir)).status).toBe(200);
    expect((await get(started, "/api/me", ivan)).status).toBe(401);
    expect((await postJson(started, "/api/login", { login: "ivan", password: "correct horse" })).status).toBe(401);
    expect((await patchJson(started, `/api/admin/users/${id}`, { active: true }, mudir)).status).toBe(200);
    await loginAs(started, "ivan", "correct horse");
  });

  it("does not let the admin take away his own role, block or delete himself", async () => {
    const { started, mudir } = await desk();
    const id = await idOf(started, mudir, "mudir");
    expect((await patchJson(started, `/api/admin/users/${id}`, { role: "cashier" }, mudir)).status).toBe(409);
    expect((await patchJson(started, `/api/admin/users/${id}`, { active: false }, mudir)).status).toBe(409);
    expect((await deleteRequest(started, `/api/admin/users/${id}`, mudir)).status).toBe(409);
    // His own name and password he may change.
    expect((await patchJson(started, `/api/admin/users/${id}`, { displayName: "Мудир" }, mudir)).status).toBe(200);
  });

  it("deletes one who wrote nothing, and keeps one who did: such a one can only be blocked", async () => {
    const { started, mudir, ivan } = await desk();
    const ownerId = await idOf(started, mudir, "owner");
    expect((await deleteRequest(started, `/api/admin/users/${ownerId}`, mudir)).status).toBe(204);
    expect((await users(started, mudir)).map((user) => user.login)).not.toContain("owner");

    const entry = { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road" };
    expect((await postJson(started, "/api/operations", entry, ivan)).status).toBe(201);
    const ivanId = await idOf(started, mudir, "ivan");
    expect((await users(started, mudir)).find((user) => user.login === "ivan")!.hasEntries).toBe(true);
    const refused = await deleteRequest(started, `/api/admin/users/${ivanId}`, mudir);
    expect([refused.status, (await refused.json()).error]).toEqual([409, "has_entries"]);
    expect((await deleteRequest(started, `/api/admin/users/${ivanId}`, mudir)).status).toBe(409);
    expect((await deleteRequest(started, `/api/admin/users/${randomUUID()}`, mudir)).status).toBe(404);
  });
});
