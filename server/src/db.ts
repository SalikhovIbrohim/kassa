import pg from "pg";

export type Database = {
  /** True when the database answers a trivial query, false otherwise. Never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
};

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
  });

  // An idle client dropping must not crash the process.
  pool.on("error", () => {});

  return {
    async ping() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
