import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// server/src/migrate.ts and server/dist/migrate.js both sit one level below server/.
const migrationsDir = new URL("../migrations/", import.meta.url);

// Arbitrary constant: makes two instances starting at once apply migrations one at a time.
const LOCK_ID = 7_301_001;

/** The database is not set up the way Kassa needs: the message is for the person who runs the server. */
export class DatabaseSetupError extends Error {}

/**
 * A migration failed. Each one runs in one transaction, so the one that failed left nothing behind;
 * `applied` are the ones that ran before it in this run. When that is empty the database is as it was,
 * and the version that ran before can still run on it (the update script goes back to it).
 */
export class MigrationFailedError extends Error {
  constructor(
    message: string,
    readonly applied: string[],
  ) {
    super(message);
  }
}

/**
 * Names, comments and everything else people type are Russian. A database that stores text in a
 * Windows code page (PostgreSQL on Windows may be set up that way, by the locale of the machine)
 * cannot keep most of it: the first Russian name fails to save. Better to refuse at the start.
 */
async function assertUtf8(client: pg.ClientBase): Promise<void> {
  const result = await client.query<{ encoding: string; database: string }>(
    "SELECT pg_encoding_to_char(encoding) AS encoding, datname AS database FROM pg_database WHERE datname = current_database()",
  );
  const row = result.rows[0];
  if (row && row.encoding !== "UTF8") {
    throw new DatabaseSetupError(
      `The database "${row.database}" stores text as ${row.encoding}, and Kassa needs UTF8: ` +
        "names and comments in Russian would fail to save. Create the database with ENCODING 'UTF8' " +
        "TEMPLATE template0 (deploy/setup-database.mjs does), and load a backup into it if there is data.",
    );
  }
}

export type MigrateOptions = {
  /**
   * Go on although the database has been changed by a newer version of Kassa than this one. Only for
   * an emergency, by someone who knows what the newer version changed: the old code may show wrong
   * balances or fail on every entry, and nothing else will say so.
   */
  allowNewerSchema?: boolean;
};

/**
 * Applies every `migrations/*.sql` file that has not run yet, in name order.
 * Forward-only: each file runs in one transaction and is recorded when done.
 * Returns the names of the files it applied.
 *
 * Refuses a database that a newer version has changed (it has migrations this version has no file
 * for): going back to older code on such a database looks like it works, while balances can be wrong.
 * The way back is the copy of the database made before the update.
 */
export async function migrate(pool: pg.Pool, options: MigrateOptions = {}): Promise<string[]> {
  const client = await pool.connect();
  try {
    await assertUtf8(client);
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(done.rows.map((row) => row.name));
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

    const fromNewerVersion = [...applied].filter((name) => !files.includes(name)).sort();
    if (fromNewerVersion.length > 0 && !options.allowNewerSchema) {
      throw new DatabaseSetupError(
        `The database was changed by a newer version of Kassa (${fromNewerVersion.join(", ")}) than this one, ` +
          "and older code on it can show wrong balances. Restore the copy of the database made before the update " +
          "(deploy/restore.mjs), or install the newer version again. Only if you know what the newer version changed: " +
          "ALLOW_NEWER_SCHEMA=1.",
      );
    }

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, migrationsDir), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationFailedError(`Migration ${file} failed: ${(error as Error).message}`, [...ran]);
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Convenience for the server start-up: connect, migrate, disconnect. */
export async function migrateDatabase(connectionString: string, options: MigrateOptions = {}): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    return await migrate(pool, options);
  } finally {
    await pool.end();
  }
}
