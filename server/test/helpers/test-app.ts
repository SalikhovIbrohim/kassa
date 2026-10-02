import { randomBytes } from "node:crypto";
import pg from "pg";
import { buildApp, type LoginProtectionOptions } from "../../src/app.js";
import { migrate } from "../../src/migrate.js";
import type { OneCSettings } from "../../src/onec-api.js";
import * as adminUsers from "../../src/admin/users.js";
import * as adminBalances from "../../src/admin/opening-balances.js";

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
  /** Amount as the developer types it, e.g. "1000.50". */
  setOpeningBalance(currency: string, amount: string): Promise<void>;
};

export type TestApp = {
  /** Changes after restart(), so read it fresh for every request. */
  readonly baseUrl: string;
  readonly admin: TestAdmin;
  /** The throwaway database, for tests that need a second connection of their own. */
  readonly databaseUrl: string;
  /**
   * Runs SQL directly. Only for data the public API cannot produce (a timestamp finer than
   * a millisecond, say); never to check what the API did.
   */
  execute(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Reads rows directly. Only for properties of the storage that cannot be seen over HTTP
   * (that a deleted operation is still in its table); never to check what the API did.
   */
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Moves the application's clock (sessions expire by it). */
  setNow(date: Date): void;
  /** Stops and starts the server again on the same database. */
  restart(): Promise<void>;
  /**
   * Runs `work` with the server stopped and no connection of the test open on its database (the
   * way the service is stopped while a copy is restored), then starts the server again.
   */
  whileStopped(work: () => Promise<void>): Promise<void>;
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
  /** Addresses of reverse proxies whose X-Forwarded-For header is believed. */
  trustProxy?: string | string[];
  loginProtection?: LoginProtectionOptions;
  /** Gets the server's log lines, for tests that look at what is logged. */
  logStream?: NodeJS.WritableStream;
  /** The token of the Telegram bot, to turn Mini App sign-in on. */
  telegramBotToken?: string;
  /** The Telegram group to tell about the incomes of clients, and where the Bot API is (a fake one, see fake-telegram.ts). */
  telegramGroupChatId?: string;
  telegramIncomeThreadId?: number;
  telegramExpenseThreadId?: number;
  telegramApiUrl?: string;
  telegramQueue?: { intervalMs?: number; baseBackoffSeconds?: number };
  /** The 1C base to write the payments of clients to (a fake one, see fake-onec.ts). */
  onec?: OneCSettings;
  onecQueue?: { intervalMs?: number; baseBackoffSeconds?: number; blockedRetrySeconds?: number };
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

  // Dropping with FORCE would also try to stop PostgreSQL's own background workers (autovacuum
  // may be looking at the database) and the test role may not: "permission denied to
  // terminate process", at random. So wait for our own connections to be really gone, then drop
  // plainly, which cancels autovacuum by itself. FORCE stays as the last resort.
  const dropDatabase = async () => {
    if (!databaseName) return;
    const name = databaseName;
    for (let attempt = 0; attempt < 40; attempt++) {
      const others = await queryAdmin(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND backend_type = 'client backend'`,
        [name],
      );
      if (others === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await runAdmin(`DROP DATABASE ${name}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await runAdmin(`DROP DATABASE ${name} WITH (FORCE)`);
  };

  let clock = new Date();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let baseUrl = "";
  const openPool = () => {
    const pool = new pg.Pool({ connectionString: url });
    // An idle connection cut by the server (a restart, a drop) must not crash the test run.
    pool.on("error", () => {});
    return pool;
  };
  let adminPool = openPool();

  const start = async () => {
    app = await buildApp({
      databaseUrl: url,
      webDistDir: options.webDistDir,
      secureCookies: options.secureCookies,
      sessionDays: options.sessionDays,
      trustProxy: options.trustProxy,
      telegramBotToken: options.telegramBotToken,
      telegramGroupChatId: options.telegramGroupChatId,
      telegramIncomeThreadId: options.telegramIncomeThreadId,
      telegramExpenseThreadId: options.telegramExpenseThreadId,
      telegramApiUrl: options.telegramApiUrl,
      telegramQueue: options.telegramQueue,
      onec: options.onec,
      onecQueue: options.onecQueue,
      loginProtection: options.loginProtection,
      logger: options.logStream ? { stream: options.logStream } : undefined,
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
    get databaseUrl() {
      return url;
    },
    async execute(sql, params) {
      await adminPool.query(sql, params);
    },
    async query<Row>(sql: string, params?: unknown[]) {
      return (await adminPool.query(sql, params)).rows as Row[];
    },
    admin: {
      createUser: (input) => adminUsers.createUser(adminPool, input),
      revokeUser: (login) => adminUsers.revokeUser(adminPool, login),
      restoreUser: (login) => adminUsers.restoreUser(adminPool, login),
      resetPassword: (login, newPassword) =>
        adminUsers.resetPassword(adminPool, login, newPassword),
      setOpeningBalance: async (currency, amount) => {
        await adminBalances.setOpeningBalance(adminPool, currency, amount);
      },
    },
    setNow(date) {
      clock = date;
    },
    async restart() {
      await app?.close();
      await start();
    },
    async whileStopped(work) {
      await app?.close();
      await adminPool.end();
      try {
        await work();
      } finally {
        adminPool = openPool();
        await start();
      }
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

/**
 * An empty throwaway database, for tests that start something of their own against it (the
 * admin command line, say). `drop` waits for stragglers, then removes it.
 */
export async function createBlankDatabase(
  options: { encoding?: string } = {},
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `kassa_test_${randomBytes(6).toString("hex")}`;
  // Another encoding needs the plain "C" locale to be allowed next to it.
  await runAdmin(
    options.encoding
      ? `CREATE DATABASE ${name} ENCODING '${options.encoding}' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`
      : `CREATE DATABASE ${name}`,
  );
  return {
    url: withDatabase(adminUrl, name),
    async drop() {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await runAdmin(`DROP DATABASE ${name}`);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await runAdmin(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}

function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function queryAdmin(statement: string, params: unknown[]): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return (await client.query(statement, params)).rows[0].n;
  } finally {
    await client.end();
  }
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
