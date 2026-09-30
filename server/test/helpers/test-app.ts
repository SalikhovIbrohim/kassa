import { randomBytes } from "node:crypto";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/migrate.js";
import * as adminUsers from "../../src/admin/users.js";

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://kassa_test:kassa_test@localhost:5432/postgres";

type Role = adminUsers.Role;

/** What the developer does with the admin commands, bound to this app's database. */
export type TestAdmin = {
  createUser(input: {
    login: string;
    password: string;
    role: Role;
    displayName?: string;
  }): Promise<unknown>;
  revokeUser(login: string): Promise<void>;
  restoreUser(login: string): Promise<void>;
  resetPassword(login: string, newPassword: string): Promise<void>;
};

export type TestApp = {
  /** Changes after restart(), so read it fresh for every request. */
  readonly baseUrl: string;
  readonly admin: TestAdmin;
  /** Moves the application's clock (sessions expire by it). */
  setNow(date: Date): void;
  /** Stops and starts the server again on the same database. */
  restart(): Promise<void>;
  /**
   * Everything the users and sessions tables hold, as one piece of text. Only for
   * checking that secrets are not stored in the clear: a storage-level property
   * that cannot be observed over HTTP.
   */
  storedCredentialsAsText(): Promise<string>;
  close(): Promise<void>;
};

type StartOptions = {
  /** Use this database instead of creating a fresh one (e.g. an unreachable one). */
  databaseUrl?: string;
  webDistDir?: string;
  secureCookies?: boolean;
  sessionDays?: number;
};

/**
 * Starts the real application on an ephemeral port against a real,
 * throwaway PostgreSQL database. Tests talk to it only over HTTP.
 * Seeding users goes through `admin`, the way the developer does it.
 */
export async function startTestApp(options: StartOptions = {}): Promise<TestApp> {
  let databaseName: string | undefined;
  let databaseUrl = options.databaseUrl;
  const createdDatabase = !databaseUrl;

  if (!databaseUrl) {
    databaseName = `kassa_test_${randomBytes(6).toString("hex")}`;
    await runAdmin(`CREATE DATABASE ${databaseName}`);
    databaseUrl = withDatabase(adminUrl, databaseName);
  }
  const url = databaseUrl;

  const dropDatabase = async () => {
    if (databaseName) {
      await runAdmin(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    }
  };

  let clock = new Date();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let baseUrl = "";
  const adminPool = new pg.Pool({ connectionString: url });

  const start = async () => {
    app = await buildApp({
      databaseUrl: url,
      webDistDir: options.webDistDir,
      secureCookies: options.secureCookies,
      sessionDays: options.sessionDays,
      now: () => clock,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  const stopAll = async () => {
    await app?.close().catch(() => {});
    await adminPool.end().catch(() => {});
    await dropDatabase().catch(() => {});
  };

  try {
    if (createdDatabase) {
      await migrate(adminPool);
    }
    await start();
  } catch (error) {
    // Setup failed half way: do not leave the throwaway database behind.
    await stopAll();
    throw error;
  }

  return {
    get baseUrl() {
      return baseUrl;
    },
    admin: {
      createUser: (input) => adminUsers.createUser(adminPool, input),
      revokeUser: (login) => adminUsers.revokeUser(adminPool, login),
      restoreUser: (login) => adminUsers.restoreUser(adminPool, login),
      resetPassword: (login, newPassword) =>
        adminUsers.resetPassword(adminPool, login, newPassword),
    },
    setNow(date) {
      clock = date;
    },
    async restart() {
      await app?.close();
      await start();
    },
    async storedCredentialsAsText() {
      const users = await adminPool.query("SELECT to_jsonb(u)::text AS row FROM users u");
      const sessions = await adminPool.query("SELECT to_jsonb(s)::text AS row FROM sessions s");
      return [...users.rows, ...sessions.rows].map((r) => r.row).join("\n");
    },
    async close() {
      try {
        await app?.close();
      } finally {
        await adminPool.end();
        await dropDatabase();
      }
    },
  };
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
