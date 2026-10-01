import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

describe("what an unexpected failure leaves in the log", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("names the failure, but not the row of the entry that was being saved", async () => {
    let log = "";
    const stream = new Writable({
      write(chunk, _encoding, done) {
        log += chunk.toString();
        done();
      },
    });
    const started = await startTestApp({ logStream: stream });
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    const cookie = await loginAs(started, "ivan", "correct horse");
    // A database fault that quotes the row, the way a constraint violation does in its "detail".
    await started.execute(`
      CREATE FUNCTION fail_with_the_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'the database refused this' USING DETAIL = 'Failing row contains (' || NEW.client_code || ')'; END
      $$;
      CREATE TRIGGER fail_with_the_row BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION fail_with_the_row();`);

    const answer = await postJson(
      started,
      "/api/operations",
      { id: randomUUID(), type: "income", amountMinor: 1_000, currency: "RUB", rateE4: 790_000, clientCode: "K-SECRET-17" },
      cookie,
    );

    expect(answer.status).toBe(500);
    expect(log).toContain("the database refused this");
    expect(log).not.toContain("K-SECRET-17");
  });
});

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

  it("keeps the server alive when the connection of a correction in progress is cut", async () => {
    const started = await startTestApp();
    app = started;
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    await started.admin.setOpeningBalance("RUB", "1000");
    const cookie = await loginAs(started, "ivan", "correct horse");
    const saved = await postJson(started, "/api/operations", expense({ id: randomUUID() }), cookie);
    expect(saved.status).toBe(201);
    const { operation } = await saved.json();

    // Someone else holds the ruble lock, so the deletion waits for it inside its transaction.
    const blocker = new pg.Client({ connectionString: started.databaseUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('kassa.balance.RUB'))");
    const pending = deleteRequest(started, `/api/operations/${operation.id}`, cookie);

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
    // The process survived: it still answers, and the same deletion goes through now.
    expect((await get(started, "/api/health")).status).toBe(200);
    const next = await deleteRequest(started, `/api/operations/${operation.id}`, cookie);
    expect(next.status).toBe(200);
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
