import { randomBytes } from "node:crypto";
import pg from "pg";
import { buildApp } from "../../src/app.js";

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://kassa_test:kassa_test@localhost:5432/postgres";

export type TestApp = {
  baseUrl: string;
  close(): Promise<void>;
};

type StartOptions = {
  /** Use this database instead of creating a fresh one (e.g. an unreachable one). */
  databaseUrl?: string;
  webDistDir?: string;
};

/**
 * Starts the real application on an ephemeral port against a real,
 * throwaway PostgreSQL database. Tests talk to it only over HTTP.
 */
export async function startTestApp(options: StartOptions = {}): Promise<TestApp> {
  let databaseName: string | undefined;
  let databaseUrl = options.databaseUrl;

  if (!databaseUrl) {
    databaseName = `kassa_test_${randomBytes(6).toString("hex")}`;
    await runAdmin(`CREATE DATABASE ${databaseName}`);
    databaseUrl = withDatabase(adminUrl, databaseName);
  }

  const dropDatabase = async () => {
    if (databaseName) {
      await runAdmin(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    }
  };

  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({ databaseUrl, webDistDir: options.webDistDir });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }

    const startedApp = app;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close() {
        try {
          await startedApp.close();
        } finally {
          await dropDatabase();
        }
      },
    };
  } catch (error) {
    // Setup failed half way: do not leave the throwaway database behind.
    await app?.close().catch(() => {});
    await dropDatabase().catch(() => {});
    throw error;
  }
}

function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function runAdmin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
