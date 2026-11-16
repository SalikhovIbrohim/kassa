import pg from "pg";
import type { Kassa, Kassas } from "./kassa.js";

/** What the database holds that the settings leave out: whole desks, and money a desk is said not to keep. */
export type OutsideSettings = {
  /** Cash desks that have entries, counts or opening balances and are not named in the settings. */
  desks: Kassa[];
  /** Money of a desk the settings name, in a currency they say it does not keep: "moscow in RUB". */
  money: string[];
};

/**
 * What the database has entries, counts or opening balances of that the settings do not cover: a cash desk they do not
 * name, or money of a desk in a currency they say it does not keep. Either would be in no balance, while its entries
 * still showed in the journal and counted in the totals in dollars.
 */
export async function outsideSettings(db: Pick<pg.Pool, "query">, kassas: Kassas): Promise<OutsideSettings> {
  const found = await db.query<{ kassa: Kassa; currency: string | null }>(
    `SELECT kassa, currency FROM operations
      UNION SELECT r.kassa, b.currency FROM reconciliations r LEFT JOIN reconciliation_balances b ON b.reconciliation_id = r.id
      UNION SELECT kassa, currency FROM opening_balances WHERE amount_minor <> 0
      ORDER BY 1, 2`,
  );
  const desks = [...new Set(found.rows.map((row) => row.kassa).filter((id) => !kassas.has(id)))];
  const money = found.rows
    .filter((row) => kassas.has(row.kassa) && row.currency !== null && !(kassas.currenciesOf(row.kassa) as readonly string[]).includes(row.currency))
    .map((row) => `${row.kassa} in ${row.currency}`);
  return { desks, money };
}

/**
 * Refuses to start on a database that has money the settings leave out (a desk taken out of KASSAS or written
 * differently there, a currency taken from a desk, the line of another company's file): better no cash desk for a
 * minute than balances that leave money out. A desk that has entries stays in KASSAS, under the id it has and with
 * the currencies it has entries in.
 */
export async function assertKassasCoverDatabase(connectionString: string, kassas: Kassas): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { desks, money } = await outsideSettings(pool, kassas);
    if (desks.length === 0 && money.length === 0) return;
    const said = kassas.list.map((item) => `${item.id}:${item.currencies.join("+")}`).join(",");
    throw new Error(
      `The cash desks of the settings (KASSAS) are ${said}, and the database has ` +
        [desks.length > 0 ? `entries of ${desks.join(", ")} too` : "", money.length > 0 ? `money of ${money.join(", ")}` : ""].filter(Boolean).join(", and ") +
        ". A cash desk that has entries, counts or an opening balance stays in KASSAS under the same id, with every currency it has them in: " +
        "put it back in the settings file (and check that this is the settings file of this company).",
    );
  } finally {
    await pool.end();
  }
}
