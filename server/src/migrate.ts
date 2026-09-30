import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// server/src/migrate.ts and server/dist/migrate.js both sit one level below server/.
const migrationsDir = new URL("../migrations/", import.meta.url);

// Arbitrary constant: makes two instances starting at once apply migrations one at a time.
const LOCK_ID = 7_301_001;

/**
 * Applies every `migrations/*.sql` file that has not run yet, in name order.
 * Forward-only: each file runs in one transaction and is recorded when done.
 * Returns the names of the files it applied.
 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(done.rows.map((row) => row.name));
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

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
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
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
export async function migrateDatabase(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    return await migrate(pool);
  } finally {
    await pool.end();
  }
}
