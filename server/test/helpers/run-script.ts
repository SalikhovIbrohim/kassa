import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type Run = { code: number | null; stdout: string; stderr: string };

/** Runs one of the scripts in deploy/ the way a person or an update script would: its own process. */
export function runScript(script: string, args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "deploy", script), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The PostgreSQL administrator the tests connect as (the scripts take it from the environment). */
export const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://kassa_test:kassa_test@localhost:5432/postgres");

export const adminEnv = {
  PGHOST: adminUrl.hostname,
  PGPORT: adminUrl.port || "5432",
  PGUSER: decodeURIComponent(adminUrl.username),
  PGPASSWORD: decodeURIComponent(adminUrl.password),
};
