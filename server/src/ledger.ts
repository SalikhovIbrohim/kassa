import type pg from "pg";
import { getBalances, type Balance } from "./balances.js";
import type { ExpenseCategory } from "./categories.js";
import type { Currency } from "./money.js";

export type OperationRow = {
  id: string;
  kind: "income" | "expense";
  amount_minor: string;
  currency: Currency;
  category: ExpenseCategory | null;
  recipient: string | null;
  client_code: string | null;
  comment: string | null;
  created_at: Date;
  author_id: string;
  author_login: string;
  author_display_name: string;
};

/** The columns every read of an operation returns: the row and who wrote it. */
export const OPERATION_SELECT = `o.*, u.login AS author_login, u.display_name AS author_display_name`;

export function toOperation(row: OperationRow) {
  return {
    id: row.id,
    type: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    category: row.category,
    recipient: row.recipient,
    clientCode: row.client_code,
    comment: row.comment,
    author: { login: row.author_login, displayName: row.author_display_name },
    createdAt: row.created_at.toISOString(),
  };
}

/** What the routes hand over, already checked and trimmed. */
export type NewOperation = {
  id: string;
  kind: "income" | "expense";
  amountMinor: number;
  currency: Currency;
  category: ExpenseCategory | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
  authorId: string;
  createdAt: Date;
};

export type RecordResult =
  /** `balances` are read in the same transaction, so the answer cannot fail after the commit. */
  | { status: "created"; row: OperationRow; balances: Balance[] }
  /** The same entry was sent before: nothing was added, here is what is stored. */
  | { status: "replayed"; row: OperationRow; balances: Balance[] }
  /** The id belongs to a different entry. */
  | { status: "id_conflict" }
  /** The cash desk holds less of that currency than the expense takes out. */
  | { status: "insufficient_balance"; availableMinor: number };

async function findOperation(db: pg.ClientBase, id: string): Promise<OperationRow | undefined> {
  const found = await db.query<OperationRow>(
    `SELECT ${OPERATION_SELECT}
       FROM operations o JOIN users u ON u.id = o.author_id
      WHERE o.id = $1`,
    [id],
  );
  return found.rows[0];
}

/** Whether the stored entry is the one being sent again: same author, same content. */
function isSameEntry(stored: OperationRow, wanted: NewOperation): boolean {
  return (
    stored.author_id === wanted.authorId &&
    stored.kind === wanted.kind &&
    Number(stored.amount_minor) === wanted.amountMinor &&
    stored.currency === wanted.currency &&
    stored.category === wanted.category &&
    stored.recipient === wanted.recipient &&
    stored.client_code === wanted.clientCode &&
    stored.comment === wanted.comment
  );
}

/**
 * Saves one operation, or says why not. The rules that depend on what is already saved
 * live here, in one transaction:
 *
 * - The id is the primary key, so an entry sent twice is stored once.
 * - An expense may not take out more of a currency than the cash desk holds. Expenses of
 *   one currency queue up behind a lock while they check the balance, otherwise two of
 *   them could each see enough money for itself and together overspend. Incomes only add
 *   money, so they need no lock.
 * - A retry of an entry that was accepted is answered as before even if the money is
 *   gone since: the check only applies to entries that are new.
 *
 * Anything else that changes a balance later (editing or deleting an operation) must
 * take the same lock and make the same check.
 */
export async function recordOperation(pool: pg.Pool, wanted: NewOperation): Promise<RecordResult> {
  const client = await pool.connect();
  // A connection lost while it is checked out reports itself as an 'error' event on the
  // client. With nobody listening, Node would end the whole process; we are already
  // handling the failure through the rejected query.
  const ignoreConnectionError = () => {};
  client.on("error", ignoreConnectionError);
  let failed = false;
  try {
    await client.query("BEGIN");

    if (wanted.kind === "expense") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kassa.balance.${wanted.currency}`]);
    }

    // The entry may be stored already: a retry, or a clash of ids.
    let stored = await findOperation(client, wanted.id);
    let created = false;

    if (!stored) {
      if (wanted.kind === "expense") {
        // This reads every operation of the currency. Fine for one cash desk (tens of
        // thousands of rows take tens of milliseconds); with far more, keep a running total.
        const balance = (await getBalances(client)).find((item) => item.currency === wanted.currency);
        const availableMinor = balance?.amountMinor ?? 0;
        if (availableMinor < wanted.amountMinor) {
          await client.query("ROLLBACK");
          return { status: "insufficient_balance", availableMinor };
        }
      }

      const inserted = await client.query(
        `INSERT INTO operations
           (id, kind, amount_minor, currency, category, recipient, client_code,
            client_code_key, comment, author_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          wanted.id,
          wanted.kind,
          wanted.amountMinor,
          wanted.currency,
          wanted.category,
          wanted.recipient,
          wanted.clientCode,
          wanted.clientCode?.toLowerCase() ?? null,
          wanted.comment,
          wanted.authorId,
          wanted.createdAt,
        ],
      );
      created = inserted.rowCount === 1;
      // Zero rows: another request with this id got in between our look and our insert (an
      // income takes no lock, and an expense in the other currency takes another one). The
      // insert waited for it to finish, so its row is visible now.
      stored = await findOperation(client, wanted.id);
    }

    if (!stored) throw new Error(`Operation ${wanted.id} is neither inserted nor found`);
    if (!created && !isSameEntry(stored, wanted)) {
      await client.query("COMMIT");
      return { status: "id_conflict" };
    }

    const balances = await getBalances(client);
    await client.query("COMMIT");
    return { status: created ? "created" : "replayed", row: stored, balances };
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.removeListener("error", ignoreConnectionError);
    // After a failure the connection may be half dead: throw it away instead of reusing it.
    client.release(failed);
  }
}
