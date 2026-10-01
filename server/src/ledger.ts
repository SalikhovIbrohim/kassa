import type pg from "pg";
import { getBalances, type Balance } from "./balances.js";
import type { ExpenseCategory } from "./categories.js";
import { CURRENCIES, type Currency } from "./money.js";

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
  /** How many times it was corrected or deleted; 0 means as first written. */
  revision: number;
  deleted_at: Date | null;
  deleted_by_login: string | null;
  deleted_by_display_name: string | null;
};

/** The columns every read of an operation returns: the row, who wrote it, who deleted it. */
export const OPERATION_SELECT = `o.*,
  u.login AS author_login, u.display_name AS author_display_name,
  d.login AS deleted_by_login, d.display_name AS deleted_by_display_name`;

export const OPERATION_FROM = `operations o
  JOIN users u ON u.id = o.author_id
  LEFT JOIN users d ON d.id = o.deleted_by`;

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
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy:
      row.deleted_by_login === null
        ? null
        : { login: row.deleted_by_login, displayName: row.deleted_by_display_name ?? row.deleted_by_login },
  };
}

/** The fields of an operation that a correction may change; the rest never changes. */
export type Snapshot = {
  amountMinor: number;
  currency: Currency;
  category: ExpenseCategory | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
};

export function snapshotOf(row: OperationRow): Snapshot {
  return {
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    category: row.category,
    recipient: row.recipient,
    clientCode: row.client_code,
    comment: row.comment,
  };
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.category === b.category &&
    a.recipient === b.recipient &&
    a.clientCode === b.clientCode &&
    a.comment === b.comment
  );
}

/** What the routes hand over, already checked and trimmed. */
export type NewOperation = Snapshot & {
  id: string;
  kind: "income" | "expense";
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

/**
 * Runs `work` in one transaction: committed when it returns, rolled back when it throws.
 * Whatever `work` writes becomes visible together, or not at all.
 */
async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  begin = "BEGIN",
): Promise<T> {
  const client = await pool.connect();
  // A connection lost while it is checked out reports itself as an 'error' event on the
  // client. With nobody listening, Node would end the whole process; we are already
  // handling the failure through the rejected query.
  const ignoreConnectionError = () => {};
  client.on("error", ignoreConnectionError);
  let failed = false;
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
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

/**
 * Queues behind everyone else who is changing the balance of these currencies, until the
 * end of the transaction. Always taken in the same order, so two transactions that each
 * need several can never wait for each other.
 */
async function lockBalances(client: pg.ClientBase, currencies: readonly Currency[]): Promise<void> {
  for (const currency of [...currencies].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kassa.balance.${currency}`]);
  }
}

async function findOperation(db: pg.ClientBase, id: string): Promise<OperationRow | undefined> {
  const found = await db.query<OperationRow>(
    `SELECT ${OPERATION_SELECT} FROM ${OPERATION_FROM} WHERE o.id = $1`,
    [id],
  );
  return found.rows[0];
}

/** What the operation said when it was first written, before any correction. */
async function originalOf(db: pg.ClientBase, stored: OperationRow): Promise<Snapshot> {
  if (stored.revision === 0) return snapshotOf(stored);
  const first = await db.query<{ state_before: Snapshot }>(
    "SELECT state_before FROM operation_changes WHERE operation_id = $1 AND revision = 1",
    [stored.id],
  );
  const original = first.rows[0]?.state_before;
  if (!original) throw new Error(`Operation ${stored.id} is at revision ${stored.revision} but has no history`);
  return original;
}

/**
 * Whether the stored operation is the one being sent again: same author, same kind, and the
 * same content as it was first written. A correction made since does not make a retry of
 * the original request a different entry.
 */
async function isSameEntry(db: pg.ClientBase, stored: OperationRow, wanted: NewOperation): Promise<boolean> {
  return (
    stored.author_id === wanted.authorId &&
    stored.kind === wanted.kind &&
    sameSnapshot(await originalOf(db, stored), wanted)
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
 * Anything else that changes a balance later (correcting or deleting an operation) takes
 * the same locks and makes the same check: see `changeOperation`.
 */
export async function recordOperation(pool: pg.Pool, wanted: NewOperation): Promise<RecordResult> {
  return inTransaction(pool, async (client): Promise<RecordResult> => {
    if (wanted.kind === "expense") await lockBalances(client, [wanted.currency]);

    // The entry may be stored already: a retry, or a clash of ids.
    let stored = await findOperation(client, wanted.id);
    let created = false;

    if (!stored) {
      if (wanted.kind === "expense") {
        // This reads every operation of the currency. Fine for one cash desk (tens of
        // thousands of rows take tens of milliseconds); with far more, keep a running total.
        const balance = (await getBalances(client)).find((item) => item.currency === wanted.currency);
        const availableMinor = balance?.amountMinor ?? 0;
        if (availableMinor < wanted.amountMinor) return { status: "insufficient_balance", availableMinor };
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
    if (!created && !(await isSameEntry(client, stored, wanted))) return { status: "id_conflict" };

    return { status: created ? "created" : "replayed", row: stored, balances: await getBalances(client) };
  });
}

/** What a cashier asks to do to one of their operations. */
export type Change =
  | { action: "edit"; kind: "income" | "expense"; next: Snapshot; reason: string | null }
  | { action: "delete"; reason: string | null };

export type ChangeResult =
  | { status: "changed" | "unchanged"; row: OperationRow; balances: Balance[] }
  | { status: "not_found" }
  /** It is somebody else's operation. */
  | { status: "not_yours" }
  /** A deleted operation can no longer be corrected. */
  | { status: "deleted" }
  /** An income cannot become an expense or the other way round. */
  | { status: "kind_changed" }
  /** The change would leave less than nothing of a currency in the cash desk. */
  | { status: "would_go_negative"; currency: Currency; balanceMinor: number; balanceAfterMinor: number };

/**
 * Corrects or deletes one of its author's operations, and writes down what it was.
 *
 * Changing an operation can lower the balance (deleting an income, raising an expense), so
 * it follows the rule recording follows: no currency may be left below zero by it. The check
 * and the write share one transaction under the locks of both currencies, so a correction
 * and an expense racing for the same money cannot both succeed. A balance that was below
 * zero already (the developer lowered the opening balance) is no obstacle to a change that
 * does not make it worse.
 *
 * Every change adds a line to the history with the author, the time, the reason and the
 * values before; nothing is ever overwritten without that line (the database insists).
 */
export async function changeOperation(
  pool: pg.Pool,
  request: { id: string; actorId: string; at: Date; change: Change },
): Promise<ChangeResult> {
  const { id, actorId, at, change } = request;

  return inTransaction(pool, async (client): Promise<ChangeResult> => {
    // Both currencies, always: a correction may move money from one to the other. Taking
    // all of them also serialises every correction, so no row lock is needed on top.
    await lockBalances(client, CURRENCIES);

    const stored = await findOperation(client, id);
    if (!stored) return { status: "not_found" };
    if (stored.author_id !== actorId) return { status: "not_yours" };

    const unchanged = async (): Promise<ChangeResult> => ({
      status: "unchanged",
      row: stored,
      balances: await getBalances(client),
    });

    if (stored.deleted_at) return change.action === "delete" ? unchanged() : { status: "deleted" };

    const before = snapshotOf(stored);
    let after = before;
    if (change.action === "edit") {
      if (change.kind !== stored.kind) return { status: "kind_changed" };
      after = change.next;
      if (sameSnapshot(before, after)) return unchanged();
    }

    // What this change does to the balance of each currency: the old effect goes, the new
    // one (none for a deletion) comes. An income adds its amount, an expense takes it away.
    const effect = (amountMinor: number) => (stored.kind === "income" ? amountMinor : -amountMinor);
    const deltas = new Map<Currency, number>();
    const add = (currency: Currency, amount: number) => deltas.set(currency, (deltas.get(currency) ?? 0) + amount);
    add(before.currency, -effect(before.amountMinor));
    if (change.action === "edit") add(after.currency, effect(after.amountMinor));

    const balances = await getBalances(client);
    for (const [currency, delta] of deltas) {
      if (delta >= 0) continue;
      const balanceMinor = balances.find((item) => item.currency === currency)?.amountMinor ?? 0;
      if (balanceMinor + delta < 0) {
        return { status: "would_go_negative", currency, balanceMinor, balanceAfterMinor: balanceMinor + delta };
      }
    }

    if (change.action === "delete") {
      await client.query(
        "UPDATE operations SET deleted_at = $2, deleted_by = $3, revision = revision + 1 WHERE id = $1",
        [id, at, actorId],
      );
    } else {
      await client.query(
        `UPDATE operations
            SET amount_minor = $2, currency = $3, category = $4, recipient = $5,
                client_code = $6, client_code_key = $7, comment = $8, revision = revision + 1
          WHERE id = $1`,
        [
          id,
          after.amountMinor,
          after.currency,
          after.category,
          after.recipient,
          after.clientCode,
          after.clientCode?.toLowerCase() ?? null,
          after.comment,
        ],
      );
    }
    await client.query(
      `INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, reason, state_before)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, stored.revision + 1, change.action, at, actorId, change.reason, JSON.stringify(before)],
    );

    const changed = await findOperation(client, id);
    if (!changed) throw new Error(`Operation ${id} disappeared while it was being changed`);
    return { status: "changed", row: changed, balances: await getBalances(client) };
  });
}

export type HistoryChange = {
  revision: number;
  action: "edit" | "delete";
  at: string;
  by: { login: string; displayName: string };
  reason: string | null;
  before: Snapshot;
  /** The same as `before` for a deletion: what it says does not change, it is only hidden. */
  after: Snapshot;
};

export type OperationHistory = {
  operation: ReturnType<typeof toOperation>;
  created: { at: string; by: { login: string; displayName: string }; state: Snapshot };
  changes: HistoryChange[];
};

/**
 * Everything that happened to an operation: how it was first written and each change after
 * that, oldest first, with what it said before and after. Undefined when there is no such
 * operation. Read in one snapshot, so a change made meanwhile cannot tear the story apart.
 */
export async function readHistory(pool: pg.Pool, id: string): Promise<OperationHistory | undefined> {
  return inTransaction(
    pool,
    async (client) => {
      const row = await findOperation(client, id);
      if (!row) return undefined;

      const lines = await client.query<{
        revision: number;
        action: "edit" | "delete";
        changed_at: Date;
        reason: string | null;
        state_before: Snapshot;
        login: string;
        display_name: string;
      }>(
        `SELECT c.revision, c.action, c.changed_at, c.reason, c.state_before, u.login, u.display_name
           FROM operation_changes c JOIN users u ON u.id = c.changed_by
          WHERE c.operation_id = $1
          ORDER BY c.revision`,
        [id],
      );

      const current = snapshotOf(row);
      const changes: HistoryChange[] = lines.rows.map((line, index) => ({
        revision: line.revision,
        action: line.action,
        at: line.changed_at.toISOString(),
        by: { login: line.login, displayName: line.display_name },
        reason: line.reason,
        before: line.state_before,
        // What the next change found, or what the operation says now.
        after: lines.rows[index + 1]?.state_before ?? current,
      }));

      return {
        operation: toOperation(row),
        created: {
          at: row.created_at.toISOString(),
          by: { login: row.author_login, displayName: row.author_display_name },
          state: changes[0]?.before ?? current,
        },
        changes,
      };
    },
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
}
