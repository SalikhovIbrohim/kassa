export type AttemptLimiterOptions = {
  /** Attempts in a row that are answered normally before waiting begins. */
  freeAttempts: number;
  /** The first wait, which then doubles with every further attempt. */
  baseWaitMs: number;
  maxWaitMs: number;
  /** Someone who has not tried for this long starts again from zero. */
  forgetAfterMs: number;
  /** The table never grows past this; the least recently tried are dropped first. */
  maxTracked: number;
};

type Entry = { attempts: number; lastAttemptAt: number };

const SWEEP_EVERY_MS = 60_000;

/**
 * Slows down guessing without ever locking anyone out for good. Each key (a login, an
 * address) has a count of attempts in a row. Once it passes the free ones the key must
 * wait, and the wait doubles with each further attempt up to a ceiling. The count is
 * forgotten after a quiet spell, so a person who mistyped is never stuck.
 *
 * An attempt is counted when it arrives (`reserve`), before anyone knows whether the
 * password is right, so a burst of parallel guesses cannot slip past the limit. A right
 * password then calls `reset` or `refund`. The table lives in memory: it starts empty
 * after a restart of the server.
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();
  private lastSweepAt = 0;

  constructor(private readonly options: AttemptLimiterOptions) {}

  /** How long `key` still has to wait, in milliseconds. Zero means it may try now. */
  waitMs(key: string, nowMs: number): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (nowMs - entry.lastAttemptAt >= this.options.forgetAfterMs) {
      this.entries.delete(key);
      return 0;
    }
    const beyondFree = entry.attempts - this.options.freeAttempts;
    if (beyondFree < 0) return 0;
    const wait = Math.min(this.options.maxWaitMs, this.options.baseWaitMs * 2 ** Math.min(beyondFree, 30));
    return Math.max(0, entry.lastAttemptAt + wait - nowMs);
  }

  /** Counts an attempt for `key` from now on. Call only when `waitMs` said zero. */
  reserve(key: string, nowMs: number): void {
    this.sweep(nowMs);
    const entry = this.entries.get(key) ?? { attempts: 0, lastAttemptAt: nowMs };
    entry.attempts += 1;
    entry.lastAttemptAt = nowMs;
    // Re-insert so the Map's order is least recently tried first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.options.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Takes one reserved attempt back: it was not a wrong guess (it worked, or never ran). */
  refund(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.attempts -= 1;
    if (entry.attempts <= 0) this.entries.delete(key);
  }

  /** Forgets `key` altogether. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drops keys that have been quiet long enough to be forgotten, at most once a minute. */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepAt < SWEEP_EVERY_MS) return;
    this.lastSweepAt = nowMs;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastAttemptAt >= this.options.forgetAfterMs) this.entries.delete(key);
    }
  }
}
