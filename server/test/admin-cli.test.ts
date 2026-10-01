import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankDatabase } from "./helpers/test-app.js";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

/** Runs the admin command line the way an update script does: its own process, its own environment. */
function runCli(args: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/admin/cli.ts", ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: undefined, KASSA_PASSWORD: undefined, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("admin command line: migrate", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function blankDatabase() {
    const database = await createBlankDatabase();
    cleanups.push(database.drop);
    return database.url;
  }

  it("builds a blank database, says what it applied, and finds nothing to do the second time", async () => {
    const url = await blankDatabase();

    const first = await runCli(["migrate"], { DATABASE_URL: url });
    const second = await runCli(["migrate"], { DATABASE_URL: url });

    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Applied migrations: 0001_users_and_sessions\.sql, .*0004_corrections\.sql/);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe("The database is up to date.");
    // The database is usable afterwards.
    const balances = await runCli(["balances"], { DATABASE_URL: url });
    expect(balances.code).toBe(0);
    expect(balances.stdout).toContain("RUB");
  }, 30_000);

  it("fails with a nonzero exit code when the database cannot be reached, so a script can stop", async () => {
    const result = await runCli(["migrate"], { DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("up to date");
    expect(result.stderr).not.toBe("");
  }, 30_000);

  it("says what is missing when there is no DATABASE_URL", async () => {
    const result = await runCli(["migrate"], {});

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required");
  }, 30_000);
});
