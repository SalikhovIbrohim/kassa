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

/** What `reserve` hands back, so that `refund` can put the key exactly as it was. */
export type Reservation = { previousLastAttemptAt: number | undefined };

/**
 * Slows down guessing without ever locking anyone out for good. Each key (a login, an
 * address) has a count of attempts in a row. Once it passes the free ones the key must
 * wait, and the wait doubles with each further attempt up to a ceiling. The count is
 * forgotten after a quiet spell, so a person who mistyped is never stuck.
 *
 * An attempt is counted when it arrives (`reserve`), before anyone knows whether the
 * password is right, so a burst of parallel guesses cannot slip past the limit. A right
 * password then calls `reset` or `refund`. The table lives in memory: it starts empty
 * after a restart of the server. Quiet keys are dropped when they are next looked at, and
 * the table never holds more than `maxTracked`, so a flood of made-up keys cannot grow it.
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: AttemptLimiterOptions) {}

  /** How long `key` still has to wait, in milliseconds. Zero means it may try now. */
  waitMs(key: string, nowMs: number): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    // The clock went back (a correction of the server's time): count from now, never from a
    // moment in the future, or the wait would grow by the size of the step.
    if (nowMs < entry.lastAttemptAt) entry.lastAttemptAt = nowMs;
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
  reserve(key: string, nowMs: number): Reservation {
    let existing = this.entries.get(key);
    if (existing && nowMs - existing.lastAttemptAt >= this.options.forgetAfterMs) existing = undefined;
    const reservation = { previousLastAttemptAt: existing?.lastAttemptAt };
    const entry = existing ?? { attempts: 0, lastAttemptAt: nowMs };
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
    return reservation;
  }

  /**
   * Takes one reserved attempt back: it was not a wrong guess (it worked, or never ran). The
   * time of the last attempt goes back too, so an attempt that was never really made does not
   * start a new wait.
   */
  refund(key: string, reservation: Reservation): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.attempts -= 1;
    if (entry.attempts <= 0) this.entries.delete(key);
    else if (reservation.previousLastAttemptAt !== undefined) entry.lastAttemptAt = reservation.previousLastAttemptAt;
  }

  /** Forgets `key` altogether. */
  reset(key: string): void {
    this.entries.delete(key);
  }
}
