import { afterEach, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

describe("GET /api/health", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports ok when the database is reachable", async () => {
    app = await startTestApp();

    const response = await fetch(`${app.baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "up" });
  });

  it("reports an error with status 503 when the database is unreachable", async () => {
    // Nothing listens on port 1, so the connection is refused.
    app = await startTestApp({
      databaseUrl: "postgres://kassa_test:kassa_test@127.0.0.1:1/none",
    });

    const response = await fetch(`${app.baseUrl}/api/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", database: "down" });
  });
});
