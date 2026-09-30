import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

describe("when the database misbehaves", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function expense(overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      type: "expense",
      amountMinor: 1_000,
      currency: "RUB",
      category: "fuel_road",
      ...overrides,
    };
  }

  it("keeps the server alive when the connection of an expense in progress is cut", async () => {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    await started.admin.setOpeningBalance("RUB", "1000");
    const cookie = await loginAs(started, "ivan", "correct horse");

    // Someone else holds the ruble lock, so the expense waits for it inside its transaction.
    const blocker = new pg.Client({ connectionString: started.databaseUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('kassa.balance.RUB'))");
    const pending = postJson(started, "/api/operations", expense(), cookie);

    // Cut that waiting connection, as a database restart or a network fault would.
    const watcher = new pg.Client({ connectionString: started.databaseUrl });
    await watcher.connect();
    let waiting: number | undefined;
    for (let i = 0; i < 100 && waiting === undefined; i++) {
      const found = await watcher.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      waiting = found.rows[0]?.pid;
      if (waiting === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(waiting).toBeDefined();
    await watcher.query("SELECT pg_terminate_backend($1)", [waiting]);
    await watcher.end();
    await blocker.query("ROLLBACK");
    await blocker.end();

    const answer = await pending;
    expect(answer.status).toBe(500);
    // The process survived: it still answers, and the next expense is recorded normally.
    expect((await get(started, "/api/health")).status).toBe(200);
    const next = await postJson(started, "/api/operations", expense(), cookie);
    expect(next.status).toBe(201);
  });

  it("does not show the database's own words when something unexpected fails", async () => {
    // A server whose database cannot be reached: the lookup of the session fails.
    app = await startTestApp({ databaseUrl: "postgres://kassa_test:kassa_test@127.0.0.1:1/nothing" });

    const response = await get(app, "/api/balances", "kassa_session=whatever");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal error",
    });
    expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|password|postgres/i);
  });
});
