import type pg from "pg";
import { getBalances } from "./balances.js";
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
  | { status: "created"; row: OperationRow }
  /** The same entry was sent before: nothing was added, here is what is stored. */
  | { status: "replayed"; row: OperationRow }
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

/** The same author sending the same content again is a retry; anything else is a clash. */
function answerForExistingId(stored: OperationRow, wanted: NewOperation): RecordResult {
  const sameEntry =
    stored.author_id === wanted.authorId &&
    stored.kind === wanted.kind &&
    Number(stored.amount_minor) === wanted.amountMinor &&
    stored.currency === wanted.currency &&
    stored.category === wanted.category &&
    stored.recipient === wanted.recipient &&
    stored.client_code === wanted.clientCode &&
    stored.comment === wanted.comment;
  return sameEntry ? { status: "replayed", row: stored } : { status: "id_conflict" };
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
  try {
    await client.query("BEGIN");

    if (wanted.kind === "expense") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kassa.balance.${wanted.currency}`]);
    }

    const existing = await findOperation(client, wanted.id);
    if (existing) {
      await client.query("COMMIT");
      return answerForExistingId(existing, wanted);
    }

    if (wanted.kind === "expense") {
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

    // Zero rows: another request with this id got in between our look and our insert (an
    // income takes no lock, and an expense in the other currency takes another one). The
    // insert waited for it to finish, so its row is visible now.
    const stored = await findOperation(client, wanted.id);
    if (!stored) throw new Error(`Operation ${wanted.id} is neither inserted nor found`);
    await client.query("COMMIT");
    return inserted.rowCount === 1
      ? { status: "created", row: stored }
      : answerForExistingId(stored, wanted);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
