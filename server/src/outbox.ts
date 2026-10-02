import type pg from "pg";
import type { Queryable } from "./balances.js";
import { sendToGroup, TelegramError, type TelegramSettings } from "./telegram-api.js";

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type OutboxOptions = {
  pool: pg.Pool;
  /** Where the messages go; undefined when the group is not set up: then nothing is queued. */
  settings: TelegramSettings | undefined;
  /** The clock of the waits between tries. The real one unless a test moves it: the application's own clock may stand still. */
  now?: () => Date;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** How often the worker looks for what is due. */
  intervalMs?: number;
  /** The first wait after a failed try, in seconds; it doubles up to a quarter of an hour. */
  baseBackoffSeconds?: number;
};

/** A message that has failed this many times is given up: it is days old and the group has moved on. */
const MAX_ATTEMPTS = 60;
const MAX_BACKOFF_SECONDS = 15 * 60;
/** A message that is being sent is not offered to anybody else for this long; if the process dies mid-send it is tried again after it. */
const LEASE_SECONDS = 60;

export type Outbox = {
  /** Whether the group is set up: with no group there is nobody to tell, and `queue` does nothing. */
  readonly enabled: boolean;
  /**
   * Writes a message to the queue, on the connection (the transaction) of the operation it is about. `topic` says whether
   * it is about an income or an expense, which decides the topic of the group it goes to.
   */
  queue(db: Queryable, text: string, operationId: string | null, topic: "income" | "expense"): Promise<void>;
  /** Asks the worker to look at the queue now. Call it after the transaction has been committed. */
  nudge(): void;
  /** Sends what is due, oldest first, until the queue is empty or the oldest is waiting for its next try. */
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

/**
 * The queue of messages for the Telegram group. Messages go out in the order they were written, one at a time: one
 * that Telegram does not take now holds the ones after it until it is sent or given up, so that the group never reads
 * "deleted" before "added".
 */
export function createOutbox(options: OutboxOptions): Outbox {
  const { pool, settings, log } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 5_000;
  const baseBackoff = options.baseBackoffSeconds ?? 15;
  const send = (text: string, threadId: number | undefined) => sendToGroup(settings!, text, threadId, options.fetchImpl);

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const later = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  /** Takes the oldest message if it is due, and keeps it from the others for a while. */
  async function claim(): Promise<{ id: string; text: string; threadId: number | null; attempts: number } | undefined> {
    const moment = now();
    const claimed = await pool.query<{ id: string; text: string; thread_id: number | null; attempts: number }>(
      `WITH head AS (
         SELECT id FROM telegram_outbox WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE telegram_outbox o
          SET attempts = o.attempts + 1, next_attempt_at = $2
         FROM head
        WHERE o.id = head.id AND o.next_attempt_at <= $1
       RETURNING o.id, o.text, o.thread_id, o.attempts`,
      [moment, later(LEASE_SECONDS)],
    );
    const row = claimed.rows[0];
    return row && { id: row.id, text: row.text, threadId: row.thread_id, attempts: row.attempts };
  }

  async function flushNow(): Promise<void> {
    while (!stopped) {
      const message = await claim();
      if (!message) return;
      try {
        await send(message.text, message.threadId ?? undefined);
        await pool.query("UPDATE telegram_outbox SET status = 'sent', sent_at = $2, last_error = NULL WHERE id = $1", [message.id, now()]);
      } catch (error) {
        const telegram = error instanceof TelegramError ? error : new TelegramError("The message could not be sent", false);
        const giveUp = telegram.permanent || message.attempts >= MAX_ATTEMPTS;
        if (giveUp) {
          log.error(`The Telegram message ${message.id} was given up after ${message.attempts} tries: ${telegram.message}`);
          await pool.query("UPDATE telegram_outbox SET status = 'failed', last_error = $2 WHERE id = $1", [message.id, telegram.message]);
          continue;
        }
        const wait = telegram.retryAfterSeconds ?? Math.min(MAX_BACKOFF_SECONDS, baseBackoff * 2 ** (message.attempts - 1));
        log.warn(`The Telegram message ${message.id} was not sent (try ${message.attempts}), the next try in ${wait} s: ${telegram.message}`);
        await pool.query("UPDATE telegram_outbox SET next_attempt_at = $2, last_error = $3 WHERE id = $1", [message.id, later(wait), telegram.message]);
        // The queue goes in order: nothing after this one is sent before it.
        return;
      }
    }
  }

  /** One pass at a time; a nudge that comes while one is under way asks for another when it ends. */
  function flush(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await flushNow().catch((error: unknown) => log.error(`The Telegram queue could not be worked through: ${(error as Error).message}`));
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    enabled: settings !== undefined,
    async queue(db, text, operationId, topic) {
      if (!settings) return;
      const threadId = topic === "income" ? settings.incomeThreadId : settings.expenseThreadId;
      await db.query(
        "INSERT INTO telegram_outbox (created_at, operation_id, text, thread_id, next_attempt_at) VALUES ($1, $2, $3, $4, $1)",
        [now(), operationId, text, threadId ?? null],
      );
    },
    nudge() {
      if (!settings || stopped) return;
      setImmediate(() => void flush());
    },
    flush,
    start() {
      if (!settings || timer) return;
      timer = setInterval(() => void flush(), intervalMs);
      timer.unref();
      void flush();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
