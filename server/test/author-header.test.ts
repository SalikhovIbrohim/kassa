import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

// The queue on a cashier's phone says whose entry it is sending (X-Kassa-As): the server takes the author
// from the session, and a phone where somebody else has signed in since must not book the entry under them.
describe("an entry sent for a named cashier", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function twoCashiers() {
    const started = await startTestApp();
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "петр", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer" });
    app = started;
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "петр", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    type: "income",
    amountMinor: 150_000,
    currency: "RUB",
    clientCode: "K17",
    ...overrides,
  });

  const journalIds = async (started: TestApp, owner: string) =>
    ((await (await get(started, "/api/operations", owner)).json()).operations as Array<{ id: string }>).map((item) => item.id);

  it("is refused, and not saved under the session's owner, when another cashier is signed in", async () => {
    const { started, petr, owner } = await twoCashiers();
    const body = income();

    const response = await postJson(started, "/api/operations", body, petr, { "X-Kassa-As": "ivan" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("wrong_session");
    expect(await journalIds(started, owner)).toEqual([]);
    // The id was not used up: the right cashier can still send it.
    const ivan = await loginAs(started, "ivan", "correct horse");
    const retry = await postJson(started, "/api/operations", body, ivan, { "X-Kassa-As": "ivan" });
    expect(retry.status).toBe(201);
    expect((await retry.json()).operation.author.login).toBe("ivan");
  });

  it("is saved when the name is the session's owner, whatever the letter case, and is a replay when sent again", async () => {
    const { started, ivan } = await twoCashiers();
    const body = income();

    const first = await postJson(started, "/api/operations", body, ivan, { "X-Kassa-As": "IVAN" });
    const again = await postJson(started, "/api/operations", body, ivan, { "X-Kassa-As": "ivan" });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
  });

  it("reads a login in another alphabet, which is sent percent-encoded", async () => {
    const { started, petr, ivan } = await twoCashiers();

    const own = await postJson(started, "/api/operations", income(), petr, { "X-Kassa-As": encodeURIComponent("Петр") });
    const other = await postJson(started, "/api/operations", income(), ivan, { "X-Kassa-As": encodeURIComponent("петр") });

    expect(own.status).toBe(201);
    expect(other.status).toBe(409);
  });

  it("refuses a name that cannot be read, and an empty one", async () => {
    const { started, ivan } = await twoCashiers();

    for (const claimed of ["%E0%A4%A", "", "ivan%00", "iv an"]) {
      const response = await postJson(started, "/api/operations", income(), ivan, { "X-Kassa-As": claimed });
      expect(response.status, JSON.stringify(claimed)).toBe(409);
    }
  });

  it("is not asked for: an entry without the header is the session owner's, as before", async () => {
    const { started, ivan } = await twoCashiers();

    const response = await postJson(started, "/api/operations", income(), ivan);

    expect(response.status).toBe(201);
  });

  it("answers who-you-are first: no session is 401, and a viewer is 403, whatever the header says", async () => {
    const { started, owner } = await twoCashiers();

    const nobody = await postJson(started, "/api/operations", income(), undefined, { "X-Kassa-As": "ivan" });
    const viewer = await postJson(started, "/api/operations", income(), owner, { "X-Kassa-As": "owner" });

    expect(nobody.status).toBe(401);
    expect(viewer.status).toBe(403);
  });
});
