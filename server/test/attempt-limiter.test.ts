import { describe, expect, it } from "vitest";
import { AttemptLimiter } from "../src/attempt-limiter.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse("2026-01-10T09:00:00Z");

function limiter(overrides: Partial<ConstructorParameters<typeof AttemptLimiter>[0]> = {}) {
  return new AttemptLimiter({
    freeAttempts: 2,
    baseWaitMs: 30 * SECOND,
    maxWaitMs: 15 * MINUTE,
    forgetAfterMs: 30 * MINUTE,
    maxTracked: 100,
    ...overrides,
  });
}

describe("the attempt limiter", () => {
  it("lets the free attempts through, then waits 30 s doubling up to the ceiling", () => {
    const l = limiter();
    const waits: number[] = [];
    let now = T0;
    for (let i = 0; i < 10; i++) {
      const wait = l.waitMs("k", now);
      waits.push(wait / SECOND);
      now += wait; // wait it out, then try again
      l.reserve("k", now);
    }

    expect(waits).toEqual([0, 0, 30, 60, 120, 240, 480, 900, 900, 900]);
  });

  it("takes a refunded attempt back completely: the count and the time of the last attempt", () => {
    const l = limiter();
    l.reserve("k", T0);
    const second = l.reserve("k", T0 + 10 * SECOND);
    expect(l.waitMs("k", T0 + 10 * SECOND)).toBe(30 * SECOND);

    l.refund("k", second);

    // Back to one attempt, made at T0: nothing to wait for, and no new wait is started.
    expect(l.waitMs("k", T0 + 10 * SECOND)).toBe(0);
    const third = l.reserve("k", T0 + 20 * SECOND);
    l.refund("k", third);
    expect(l.waitMs("k", T0 + 20 * SECOND)).toBe(0);
  });

  it("does not let a refunded attempt restart a wait that was about to end", () => {
    const l = limiter();
    l.reserve("k", T0);
    l.reserve("k", T0); // two attempts: the free ones are used up, waiting has begun
    expect(l.waitMs("k", T0)).toBe(30 * SECOND);
    const later = T0 + 31 * SECOND;
    expect(l.waitMs("k", later)).toBe(0);

    const attempt = l.reserve("k", later); // a third attempt, charged on arrival...
    l.refund("k", attempt); // ...but it never reached the password check

    expect(l.waitMs("k", later)).toBe(0);
  });

  it("forgets a key after the quiet time, not before", () => {
    const history = (l: AttemptLimiter) => {
      l.reserve("k", T0);
      l.reserve("k", T0);
      l.reserve("k", T0 + 1 * MINUTE); // three attempts, the last one at +1 min
    };
    const remembering = limiter();
    const forgetting = limiter();
    history(remembering);
    history(forgetting);

    // 29 quiet minutes after the last attempt: still remembered, the next one is the fourth.
    const soon = T0 + 30 * MINUTE;
    remembering.reserve("k", soon);
    // 30 quiet minutes: forgotten, the next one is the first.
    const later = T0 + 31 * MINUTE;
    forgetting.reserve("k", later);

    expect(remembering.waitMs("k", soon)).toBe(120 * SECOND);
    expect(forgetting.waitMs("k", later)).toBe(0);
  });

  it("never waits longer than the ceiling because the clock jumped back", () => {
    const l = limiter();
    l.reserve("k", T0);
    l.reserve("k", T0);

    const afterStepBack = l.waitMs("k", T0 - 10 * MINUTE);

    expect(afterStepBack).toBe(30 * SECOND);
    expect(l.waitMs("k", T0 - 10 * MINUTE + 30 * SECOND)).toBe(0);
  });

  it("keeps at most `maxTracked` keys, dropping the least recently tried", () => {
    const l = limiter({ maxTracked: 2, freeAttempts: 0 });
    l.reserve("a", T0);
    l.reserve("b", T0);
    l.reserve("a", T0); // a is now more recent than b
    l.reserve("c", T0); // pushes b out

    expect(l.waitMs("a", T0)).toBeGreaterThan(0);
    expect(l.waitMs("b", T0)).toBe(0);
    expect(l.waitMs("c", T0)).toBeGreaterThan(0);
  });
});
