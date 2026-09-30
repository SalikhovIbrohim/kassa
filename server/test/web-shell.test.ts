import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

describe("web app shell", () => {
  let webDistDir: string;
  let app: TestApp | undefined;

  beforeAll(async () => {
    // A stand-in for the folder that `vite build` produces.
    webDistDir = await mkdtemp(join(tmpdir(), "kassa-web-"));
    await writeFile(
      join(webDistDir, "index.html"),
      '<!doctype html><html lang="ru"><head><title>Касса</title></head><body><div id="root"></div></body></html>',
    );
    await writeFile(join(webDistDir, "manifest.webmanifest"), '{"name":"Касса"}');
    await mkdir(join(webDistDir, "assets"));
    await writeFile(join(webDistDir, "assets", "app-3f9a1c.js"), "console.log('kassa');");
  });

  afterAll(async () => {
    await rm(webDistDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves the app shell at the root", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>Касса</title>");
  });

  it("never lets the shell be cached, so a new deploy is picked up", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/`);

    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("lets the browser cache hashed assets for a long time", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/assets/app-3f9a1c.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves the manifest as a web app manifest", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/manifest.webmanifest`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
  });

  it("still never caches the shell when the install folder itself is named assets", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kassa-install-"));
    const installDir = join(parent, "assets", "kassa");
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, "index.html"), "<title>Касса</title>");
    app = await startTestApp({ webDistDir: installDir });

    try {
      const response = await fetch(`${app.baseUrl}/`);

      expect(response.headers.get("cache-control")).toBe("no-cache");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("serves the shell for deep links so a reload keeps the user in the app", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/journal/2026-09-30`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>Касса</title>");
  });

  it("answers an unknown API route with a JSON 404, not the shell", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/api/no-such-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("answers a missing file with a 404 instead of the shell", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/assets/missing-123.js`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("answers a non-GET request to an unknown path with a 404", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/journal`, { method: "POST" });

    expect(response.status).toBe(404);
  });

  it("does not treat the bare /api path as an app route", async () => {
    app = await startTestApp({ webDistDir });

    const response = await fetch(`${app.baseUrl}/api`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
