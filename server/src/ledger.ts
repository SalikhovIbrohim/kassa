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
  /** The shift it was entered in; null for operations from before there were shifts, or without a shift of the author's own. */
  shift_id: string | null;
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
    shiftId: row.shift_id,
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
  /** The shift the sender says was open when the entry was made (a phone that was offline); see `shiftFor`. */
  shiftId?: string | null;
};

export type RecordResult =
  /** `balances` are read in the same transaction, so the answer cannot fail after the commit. */
  | { status: "created"; row: OperationRow; balances: Balance[] }
  /** The same entry was sent before: nothing was added, here is what is stored. */
  | { status: "replayed"; row: OperationRow; balances: Balance[] }
  /** The id belongs to a different entry. */
  | { status: "id_conflict" };

/**
 * Runs `work` in one transaction: committed when it returns, rolled back when it throws.
 * Whatever `work` writes becomes visible together, or not at all.
 */
export async function inTransaction<T>(
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
export async function lockBalances(client: pg.ClientBase, currencies: readonly Currency[]): Promise<void> {
  for (const currency of [...currencies].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kassa.balance.${currency}`]);
  }
}

/**
 * The shift a new operation belongs to. A phone that was offline says which shift was open on it when the
 * entry was made, and that one counts, also if it has been closed since. Otherwise it is the shift the author
 * has open now. Never a shift of somebody else, never one that does not exist: an entry is not refused for
 * that, it simply belongs to no shift (the owner sees it as one made outside a shift).
 */
async function shiftFor(db: pg.ClientBase, authorId: string, named: string | null | undefined): Promise<string | null> {
  if (named) {
    const found = await db.query<{ id: string }>("SELECT id FROM shifts WHERE id = $1 AND cashier_id = $2", [named, authorId]);
    if (found.rows[0]) return found.rows[0].id;
  }
  const open = await db.query<{ id: string }>("SELECT id FROM shifts WHERE closed_at IS NULL AND cashier_id = $1", [authorId]);
  return open.rows[0]?.id ?? null;
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
 * - The balance is no limit. This is a cash desk that is kept in step with a book that has no
 *   limit either: an expense that takes the balance below zero is recorded all the same (the
 *   screen shows the balance in red), because refusing it would leave the money unwritten.
 * - A retry of an entry that was accepted is answered as before. The answer is read in one
 *   snapshot (see `answerRetry`), so it never mixes two moments.
 */
export async function recordOperation(pool: pg.Pool, wanted: NewOperation): Promise<RecordResult> {
  const recorded = await inTransaction(pool, async (client): Promise<RecordResult | "stored already"> => {
    // The entry may be stored already: a retry, or a clash of ids.
    if (await findOperation(client, wanted.id)) return "stored already";

    const inserted = await client.query(
      `INSERT INTO operations
         (id, kind, amount_minor, currency, category, recipient, client_code,
          client_code_key, comment, author_id, created_at, shift_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        await shiftFor(client, wanted.authorId, wanted.shiftId),
      ],
    );
    // Zero rows: another request with this id got in between our look and our insert. The
    // insert waited for it to finish, so the entry is stored now.
    if (inserted.rowCount !== 1) return "stored already";

    const row = await findOperation(client, wanted.id);
    if (!row) throw new Error(`Operation ${wanted.id} is neither inserted nor found`);
    return { status: "created", row, balances: await getBalances(client) };
  });

  return recorded === "stored already" ? answerRetry(pool, wanted) : recorded;
}

/**
 * The answer to a request for an entry that is stored already: the same entry (nothing is
 * added, here is what is stored) or a different one under the same id. Operation and balances
 * come from one snapshot. Read statement by statement, a correction or a deletion that is
 * committed in between would leave an answer showing the operation as it was and the
 * balances as they are.
 */
async function answerRetry(pool: pg.Pool, wanted: NewOperation): Promise<RecordResult> {
  return inTransaction(
    pool,
    async (client): Promise<RecordResult> => {
      const stored = await findOperation(client, wanted.id);
      // Nothing is ever physically deleted, so what was there a moment ago is still there.
      if (!stored) throw new Error(`Operation ${wanted.id} was stored and is gone`);
      if (!(await isSameEntry(client, stored, wanted))) return { status: "id_conflict" };
      return { status: "replayed", row: stored, balances: await getBalances(client) };
    },
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
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
  | { status: "kind_changed" };

/**
 * Corrects or deletes one of its author's operations, and writes down what it was.
 *
 * Changing an operation can lower the balance (deleting an income, raising an expense). As with
 * recording, the balance is no limit: it may end below zero.
 *
 * Every change adds a line to the history with the author, the time, the reason and the
 * values before; nothing is ever overwritten without that line (the database insists).
 */
export async function changeOperation(
  pool: pg.Pool,
  request: { id: string; actorId: string; now: () => Date; change: Change },
): Promise<ChangeResult> {
  const { id, actorId, now, change } = request;

  return inTransaction(pool, async (client): Promise<ChangeResult> => {
    // Both currencies, always: a correction may move money from one to the other. Taking
    // all of them also serialises every correction, so no row lock is needed on top.
    await lockBalances(client, CURRENCIES);
    // The time of the change is read once the turn has come, not when the request arrived:
    // a request that waited for the lock must not be dated before the change it waited for.
    const at = now();

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
