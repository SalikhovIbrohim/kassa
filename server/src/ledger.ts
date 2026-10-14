import type pg from "pg";
import { getBalances, type Balance } from "./balances.js";
import { cashDayStartSql } from "./cash-day.js";
import { CURRENCIES, toUsdMinor, type Currency } from "./money.js";

export type OperationRow = {
  id: string;
  kind: "income" | "expense";
  amount_minor: string;
  currency: Currency;
  /** Rubles for one dollar, times 10 000 (bigint comes as text); only for rubles. */
  rate_e4: string | null;
  /** For a ruble expense without a rate of its own: the average rate of the ruble incomes of its day (see `dayAverageRateSql`). */
  day_average_rate_e4: string | null;
  category: string | null;
  recipient: string | null;
  client_code: string | null;
  /** The number of the trip, when the category asks for one. */
  trip_number: number | null;
  counterparty: string | null;
  employee: string | null;
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

/**
 * SQL for the rate at which a ruble expense without a rate of its own is counted in dollars: the average of the rates of
 * the ruble incomes of its day (null for any other operation). A day with no ruble income takes the rate of the last one
 * before the day ended; none at all, none. It is worked out when read, so what is entered later in the day moves it, and
 * once the day is over (03:00) it only moves if an income of that day is corrected.
 */
export function dayAverageRateSql(operation: string): string {
  const dayStart = cashDayStartSql(`${operation}.created_at`);
  const rated = "i.kind = 'income' AND i.currency = 'RUB' AND i.rate_e4 IS NOT NULL AND i.deleted_at IS NULL";
  return `CASE WHEN ${operation}.kind = 'expense' AND ${operation}.currency = 'RUB' AND ${operation}.rate_e4 IS NULL THEN COALESCE(
      (SELECT ROUND(AVG(i.rate_e4))::bigint FROM operations i
        WHERE ${rated} AND i.created_at >= ${dayStart} AND i.created_at < ${dayStart} + interval '24 hours'),
      (SELECT i.rate_e4 FROM operations i
        WHERE ${rated} AND i.created_at < ${dayStart} + interval '24 hours'
        ORDER BY i.created_at DESC, i.id DESC LIMIT 1)) END`;
}

/** The columns every read of an operation returns: the row, who wrote it, who deleted it. */
export const OPERATION_SELECT = `o.*,
  ${dayAverageRateSql("o")} AS day_average_rate_e4,
  u.login AS author_login, u.display_name AS author_display_name,
  d.login AS deleted_by_login, d.display_name AS deleted_by_display_name`;

export const OPERATION_FROM = `operations o
  JOIN users u ON u.id = o.author_id
  LEFT JOIN users d ON d.id = o.deleted_by`;

/**
 * What a ruble operation is in dollars, and by which rate: its own, or for an expense without one the
 * average of its day. Dollars are what they are. Null when there is no rate at all yet.
 */
export function inDollars(row: OperationRow): { usdMinor: number | null; rateSource: "own" | "day" | null } {
  const amountMinor = Number(row.amount_minor);
  if (row.currency === "USD") return { usdMinor: amountMinor, rateSource: null };
  if (row.rate_e4 !== null) return { usdMinor: toUsdMinor(amountMinor, Number(row.rate_e4)), rateSource: "own" };
  if (row.kind === "expense" && row.day_average_rate_e4 !== null) {
    return { usdMinor: toUsdMinor(amountMinor, Number(row.day_average_rate_e4)), rateSource: "day" };
  }
  return { usdMinor: null, rateSource: null };
}

export function toOperation(row: OperationRow) {
  const dollars = inDollars(row);
  return {
    id: row.id,
    type: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    rateE4: row.rate_e4 === null ? null : Number(row.rate_e4),
    usdMinor: dollars.usdMinor,
    rateSource: dollars.rateSource,
    category: row.category,
    recipient: row.recipient,
    clientCode: row.client_code,
    tripNumber: row.trip_number,
    counterparty: row.counterparty,
    employee: row.employee,
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
  /** Rubles for one dollar, times 10 000; null for dollars and for a ruble expense without one. */
  rateE4: number | null;
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  /** The number of the trip and the counterparty: only where the category asks for them. */
  tripNumber: number | null;
  counterparty: string | null;
  /** The employee: only where the category asks for one. */
  employee: string | null;
  comment: string | null;
};

export function snapshotOf(row: OperationRow): Snapshot {
  return {
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    rateE4: row.rate_e4 === null ? null : Number(row.rate_e4),
    category: row.category,
    recipient: row.recipient,
    clientCode: row.client_code,
    tripNumber: row.trip_number,
    counterparty: row.counterparty,
    employee: row.employee,
    comment: row.comment,
  };
}

/** A line of history as it was kept: older lines were written before there was a rate, a trip, a counterparty or an employee, and have none. */
export function readSnapshot(
  kept: Omit<Snapshot, "rateE4" | "tripNumber" | "counterparty" | "employee"> & {
    rateE4?: number | null;
    tripNumber?: number | null;
    counterparty?: string | null;
    employee?: string | null;
  },
): Snapshot {
  return { ...kept, rateE4: kept.rateE4 ?? null, tripNumber: kept.tripNumber ?? null, counterparty: kept.counterparty ?? null, employee: kept.employee ?? null };
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.rateE4 === b.rateE4 &&
    a.category === b.category &&
    a.recipient === b.recipient &&
    a.clientCode === b.clientCode &&
    a.tripNumber === b.tripNumber &&
    a.counterparty === b.counterparty &&
    a.employee === b.employee &&
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

/**
 * What else is to happen in the transaction that records or changes an operation, so that it is written with it or not
 * at all (the messages for the Telegram group are: see `clientIncomeEvents`).
 */
export type LedgerEvents = {
  /** A new operation was written. */
  created?: (db: pg.PoolClient, row: OperationRow) => Promise<void>;
  /** An operation was corrected or deleted: `before` is what it said, `row` what it says now. */
  changed?: (
    db: pg.PoolClient,
    event: {
      action: "edit" | "delete";
      before: Snapshot;
      row: OperationRow;
      actorId: string;
      reason: string | null;
      at: Date;
      /** The admin changed an entry that was not his to change any more: somebody else's, or one past its day. */
      byAdmin?: boolean;
    },
  ) => Promise<void>;
};

/** Several lists of events as one: each is run, in order, in the same transaction. */
export function mergeEvents(...lists: Array<LedgerEvents | undefined>): LedgerEvents | undefined {
  const parts = lists.filter((item): item is LedgerEvents => item !== undefined);
  if (parts.length === 0) return undefined;
  return {
    async created(db, row) {
      for (const part of parts) await part.created?.(db, row);
    },
    async changed(db, event) {
      for (const part of parts) await part.changed?.(db, event);
    },
  };
}

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
  const first = await db.query<{ state_before: Parameters<typeof readSnapshot>[0] }>(
    "SELECT state_before FROM operation_changes WHERE operation_id = $1 AND revision = 1",
    [stored.id],
  );
  const original = first.rows[0]?.state_before;
  if (!original) throw new Error(`Operation ${stored.id} is at revision ${stored.revision} but has no history`);
  return readSnapshot(original);
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
export async function recordOperation(pool: pg.Pool, wanted: NewOperation, events?: LedgerEvents): Promise<RecordResult> {
  const recorded = await inTransaction(pool, async (client): Promise<RecordResult | "stored already"> => {
    // The entry may be stored already: a retry, or a clash of ids.
    if (await findOperation(client, wanted.id)) return "stored already";

    const inserted = await client.query(
      `INSERT INTO operations
         (id, kind, amount_minor, currency, rate_e4, category, recipient, client_code,
          client_code_key, comment, author_id, created_at, trip_number, counterparty, employee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO NOTHING`,
      [
        wanted.id,
        wanted.kind,
        wanted.amountMinor,
        wanted.currency,
        wanted.rateE4,
        wanted.category,
        wanted.recipient,
        wanted.clientCode,
        wanted.clientCode?.toLowerCase() ?? null,
        wanted.comment,
        wanted.authorId,
        wanted.createdAt,
        wanted.tripNumber,
        wanted.counterparty,
        wanted.employee,
      ],
    );
    // Zero rows: another request with this id got in between our look and our insert. The
    // insert waited for it to finish, so the entry is stored now.
    if (inserted.rowCount !== 1) return "stored already";

    const row = await findOperation(client, wanted.id);
    if (!row) throw new Error(`Operation ${wanted.id} is neither inserted nor found`);
    await events?.created?.(client, row);
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
  /** Its author's day to correct it is over: only the admin may change it now. */
  | { status: "too_late" }
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
/** How long the author of an entry may correct or delete it; after that only the admin may. */
export const OWN_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function changeOperation(
  pool: pg.Pool,
  request: { id: string; actorId: string; actorIsAdmin?: boolean; now: () => Date; change: Change; events?: LedgerEvents },
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
    // The author has a day to put right their own mistake; the admin may change any entry at any time, and the group
    // is told when it was not his own entry within its day.
    const own = stored.author_id === actorId;
    const inTime = at.getTime() - stored.created_at.getTime() < OWN_CHANGE_WINDOW_MS;
    const byAdmin = !(own && inTime);
    if (byAdmin && !request.actorIsAdmin) return { status: own ? "too_late" : "not_yours" };

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
            SET amount_minor = $2, currency = $3, rate_e4 = $9, category = $4, recipient = $5,
                client_code = $6, client_code_key = $7, comment = $8, trip_number = $10, counterparty = $11, employee = $12,
                revision = revision + 1
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
          after.rateE4,
          after.tripNumber,
          after.counterparty,
          after.employee,
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
    await request.events?.changed?.(client, { action: change.action, before, row: changed, actorId, reason: change.reason, at, byAdmin });
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
        state_before: Parameters<typeof readSnapshot>[0];
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
        before: readSnapshot(line.state_before),
        // What the next change found, or what the operation says now.
        after: lines.rows[index + 1] ? readSnapshot(lines.rows[index + 1]!.state_before) : current,
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
