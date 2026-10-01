import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { NetworkError, type Balance, type Operation, type OperationInput, type OperationResult } from "./api";
import { createQueue, type QueuedEntry, type QueueDeps } from "./queue";
import { indexedDbStore, memoryStore } from "./queue-store";

/**
 * A stand-in for the server that keeps the one rule the queue depends on: an id is saved once,
 * and asking again answers with what was saved. It can be cut off, and it can lose answers.
 */
function fakeServer() {
  const saved = new Map<string, Operation>();
  const log: string[] = [];
  const server = {
    saved,
    log,
    /** No connection at all: nothing reaches the server. */
    offline: false,
    /** The server saves the entry, but the answer never gets back. */
    loseAnswers: false,
    /** Answer every request with this reason instead. */
    answer: undefined as undefined | OperationResult,
    cash: 0,
    async send(input: OperationInput): Promise<OperationResult> {
      log.push(`send ${input.id}`);
      if (server.offline) throw new NetworkError("offline");
      if (server.answer) return server.answer;
      const known = saved.get(input.id);
      if (!known) {
        if (input.type === "expense" && input.amountMinor > server.cash) {
          return { ok: false, reason: "insufficient-balance", currency: input.currency, availableMinor: server.cash };
        }
        server.cash += input.type === "income" ? input.amountMinor : -input.amountMinor;
        saved.set(input.id, operationOf(input));
      }
      if (server.loseAnswers) throw new NetworkError("answer lost");
      return { ok: true, operation: saved.get(input.id)!, balances: balances(server.cash) };
    },
  };
  return server;
}

const balances = (cash: number): Balance[] => [{ currency: "RUB", amountMinor: cash }];

function operationOf(input: OperationInput): Operation {
  return {
    id: input.id,
    type: input.type,
    amountMinor: input.amountMinor,
    currency: input.currency,
    category: input.type === "expense" ? input.category : null,
    recipient: null,
    clientCode: input.clientCode ?? null,
    comment: input.comment ?? null,
    author: { login: "ivan", displayName: "Иван" },
    createdAt: "2026-03-05T08:30:00.000Z",
    revision: 0,
    deletedAt: null,
    deletedBy: null,
  };
}

let counter = 0;
const income = (amountMinor = 50_000): OperationInput => ({
  type: "income",
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  amountMinor,
  currency: "RUB",
  clientCode: "K17",
});
const expense = (amountMinor = 10_000): OperationInput => ({
  type: "expense",
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  amountMinor,
  currency: "RUB",
  category: "fuel_road",
});

function setup(options: Partial<QueueDeps> & { login?: string | null } = {}) {
  const server = fakeServer();
  const store = options.store ?? memoryStore();
  const timers: Array<{ ms: number; callback: () => void; cleared: boolean }> = [];
  let login: string | null = options.login === undefined ? "ivan" : options.login;
  const savedBalances: Balance[][] = [];
  const queue = createQueue({
    store,
    send: (input) => server.send(input),
    currentLogin: () => login,
    onSaved: (value) => savedBalances.push(value),
    setTimer: (callback, ms) => {
      const timer = { ms, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...options,
  });
  return {
    server,
    store,
    queue,
    timers,
    savedBalances,
    signInAs: (next: string | null) => {
      login = next;
    },
    stored: async () => (await store.list()).map((entry) => entry.id),
  };
}

describe("the queue of entries made without a connection", () => {
  it("sends an entry at once when the server answers, and keeps nothing", async () => {
    const t = setup();
    const entry = income();

    const outcome = await t.queue.submit(entry, "ivan");

    expect(outcome.kind).toBe("saved");
    expect([...t.server.saved.keys()]).toEqual([entry.id]);
    expect(await t.stored()).toEqual([]);
    expect(t.savedBalances).toEqual([balances(50_000)]);
    expect(t.queue.getState().entries).toEqual([]);
  });

  it("writes the entry to the phone before it is sent, so that a closed app cannot lose it", async () => {
    const store = memoryStore();
    let storedWhenSending: string[] = [];
    const t = setup({
      store,
      send: async (input) => {
        storedWhenSending = (await store.list()).map((entry) => entry.id);
        throw new NetworkError("offline");
      },
    });
    const entry = income();

    await t.queue.submit(entry, "ivan");

    expect(storedWhenSending).toEqual([entry.id]);
  });

  it("keeps an entry on the phone while there is no connection, and says so", async () => {
    const t = setup();
    t.server.offline = true;
    const entry = income();

    const outcome = await t.queue.submit(entry, "ivan");

    expect(outcome).toEqual({ kind: "kept", why: "offline" });
    expect(await t.stored()).toEqual([entry.id]);
    expect(t.server.saved.size).toBe(0);
    expect(t.queue.getState()).toMatchObject({ offline: true, needsLogin: false });
    expect(t.queue.getState().entries).toHaveLength(1);
  });

  it("sends the kept entries by itself when the connection is back, each exactly once", async () => {
    const t = setup();
    t.server.offline = true;
    const first = income(30_000);
    const second = expense(10_000);
    await t.queue.submit(first, "ivan");
    await t.queue.submit(second, "ivan");

    t.server.offline = false;
    await t.queue.nudge();
    await t.queue.nudge();

    expect([...t.server.saved.keys()]).toEqual([first.id, second.id]);
    expect(t.server.cash).toBe(20_000);
    expect(await t.stored()).toEqual([]);
    expect(t.queue.getState()).toMatchObject({ offline: false, sending: false });
  });

  it("does not count an entry twice when the server saved it but the answer never came back", async () => {
    const t = setup();
    t.server.loseAnswers = true;
    const entry = income(50_000);

    const first = await t.queue.submit(entry, "ivan");
    expect(first).toEqual({ kind: "kept", why: "offline" });
    expect(t.server.cash).toBe(50_000);

    t.server.loseAnswers = false;
    await t.queue.nudge();
    await t.queue.nudge();

    expect(t.server.saved.size).toBe(1);
    expect(t.server.cash).toBe(50_000);
    expect(await t.stored()).toEqual([]);
  });

  it("sends oldest first and stops at the first entry the connection cannot carry", async () => {
    const t = setup();
    t.server.offline = true;
    const ids = [];
    for (const amount of [10_000, 20_000, 30_000]) {
      const entry = income(amount);
      ids.push(entry.id);
      await t.queue.submit(entry, "ivan");
    }
    t.server.log.length = 0;

    t.server.offline = false;
    const dropAfterOne = t.server.send.bind(t.server);
    let calls = 0;
    t.server.send = async (input) => {
      if (++calls === 2) t.server.offline = true;
      return dropAfterOne(input);
    };
    await t.queue.nudge();

    expect([...t.server.saved.keys()]).toEqual([ids[0]]);
    expect(await t.stored()).toEqual([ids[1], ids[2]]);
    expect(t.server.log).toEqual([`send ${ids[0]}`, `send ${ids[1]}`]);
  });

  it("sends one entry at a time, even when asked for several at once", async () => {
    const order: string[] = [];
    const t = setup({
      send: async (input) => {
        order.push(`start ${input.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${input.id}`);
        return { ok: true, operation: operationOf(input), balances: balances(0) };
      },
    });
    const a = income();
    const b = income();

    await Promise.all([t.queue.submit(a, "ivan"), t.queue.submit(b, "ivan")]);

    expect(order).toEqual([`start ${a.id}`, `end ${a.id}`, `start ${b.id}`, `end ${b.id}`]);
  });

  describe("an entry the server refuses for what it says", () => {
    it("is not kept when it was typed just now: the form shows the reason", async () => {
      const t = setup();
      t.server.cash = 1_000;
      const entry = expense(50_000);

      const outcome = await t.queue.submit(entry, "ivan");

      expect(outcome).toEqual({
        kind: "refused",
        problem: { kind: "insufficient-balance", currency: "RUB", availableMinor: 1_000 },
      });
      expect(await t.stored()).toEqual([]);
      expect(t.queue.getState().entries).toEqual([]);
    });

    it("stays on the phone, marked, when it was refused after waiting; the other entries still go out", async () => {
      const t = setup();
      t.server.offline = true;
      const spend = expense(80_000);
      const receive = income(10_000);
      await t.queue.submit(spend, "ivan");
      await t.queue.submit(receive, "ivan");

      t.server.offline = false;
      await t.queue.nudge();

      expect(t.server.saved.has(receive.id)).toBe(true);
      expect(t.server.saved.has(spend.id)).toBe(false);
      const [blocked] = t.queue.getState().entries;
      expect(blocked).toMatchObject({
        id: spend.id,
        status: "blocked",
        problem: { kind: "insufficient-balance", currency: "RUB", availableMinor: 10_000 },
      });
      expect(await t.stored()).toEqual([spend.id]);
    });

    it("is tried once more after money came in that covers it, in the same run", async () => {
      const t = setup();
      t.server.offline = true;
      const spend = expense(40_000);
      const receive = income(50_000);
      await t.queue.submit(spend, "ivan");
      await t.queue.submit(receive, "ivan");

      t.server.offline = false;
      await t.queue.nudge();

      expect([...t.server.saved.keys()].sort()).toEqual([spend.id, receive.id].sort());
      expect(t.server.cash).toBe(10_000);
      expect(await t.stored()).toEqual([]);
    });

    it("is not sent again and again by itself, only when the cashier asks", async () => {
      const t = setup();
      t.server.offline = true;
      const spend = expense(80_000);
      await t.queue.submit(spend, "ivan");
      t.server.offline = false;
      await t.queue.nudge();
      t.server.log.length = 0;

      await t.queue.nudge();
      await t.queue.nudge();
      expect(t.server.log).toEqual([]);

      t.server.cash = 100_000;
      await t.queue.retry(spend.id);
      expect(t.server.saved.has(spend.id)).toBe(true);
      expect(await t.stored()).toEqual([]);
    });

    it("can be given up by the cashier, and is then gone for good", async () => {
      const t = setup();
      t.server.offline = true;
      const spend = expense(80_000);
      await t.queue.submit(spend, "ivan");
      t.server.offline = false;
      await t.queue.nudge();

      await t.queue.discard(spend.id);

      expect(await t.stored()).toEqual([]);
      expect(t.queue.getState().entries).toEqual([]);
    });

    it("also covers the other things the server can refuse: a clash of ids, a refusal of rights, bad data", async () => {
      for (const reason of ["conflict", "forbidden", "rejected"] as const) {
        const t = setup();
        t.server.offline = true;
        const entry = income();
        await t.queue.submit(entry, "ivan");
        t.server.offline = false;
        t.server.answer = { ok: false, reason };

        await t.queue.nudge();

        expect(t.queue.getState().entries[0], reason).toMatchObject({ status: "blocked", problem: { kind: reason } });
      }
    });
  });

  describe("when the session has ended", () => {
    it("keeps the entry, asks for a login, and sends it after the cashier has signed in", async () => {
      const t = setup();
      t.server.answer = { ok: false, reason: "session-expired" };
      const entry = income();

      const outcome = await t.queue.submit(entry, "ivan");

      expect(outcome).toEqual({ kind: "kept", why: "login" });
      expect(t.queue.getState()).toMatchObject({ needsLogin: true });
      expect(await t.stored()).toEqual([entry.id]);
      // No retrying behind a closed door.
      expect(t.timers.filter((timer) => !timer.cleared)).toEqual([]);

      t.server.answer = undefined;
      await t.queue.nudge();

      expect(t.server.saved.has(entry.id)).toBe(true);
      expect(t.queue.getState()).toMatchObject({ needsLogin: false, entries: [] });
    });

    it("does not send an entry under the session of another cashier", async () => {
      const t = setup();
      t.server.offline = true;
      const entry = income();
      await t.queue.submit(entry, "ivan");
      t.server.offline = false;
      t.server.log.length = 0;

      t.signInAs("petr");
      await t.queue.nudge();

      expect(t.server.log).toEqual([]);
      expect(await t.stored()).toEqual([entry.id]);

      t.signInAs("ivan");
      await t.queue.nudge();

      expect(t.server.saved.has(entry.id)).toBe(true);
    });

    it("sends nothing while nobody is signed in", async () => {
      const t = setup({ login: null });
      t.server.offline = true;
      await t.queue.submit(income(), "ivan");
      t.server.offline = false;
      t.server.log.length = 0;

      await t.queue.nudge();

      expect(t.server.log).toEqual([]);
    });
  });

  describe("trying again by itself", () => {
    it("waits longer after every failure, up to a minute, and goes quiet after a success", async () => {
      const t = setup();
      await t.queue.start();
      t.server.offline = true;
      await t.queue.submit(income(), "ivan");
      const waits: number[] = [];
      const fireTheTimer = async () => {
        const [pending] = t.timers.filter((timer) => !timer.cleared);
        waits.push(pending!.ms);
        pending!.cleared = true;
        pending!.callback();
        // The try runs on its own; let it finish.
        await new Promise((resolve) => setTimeout(resolve, 0));
      };

      for (let i = 0; i < 6; i++) await fireTheTimer();
      t.server.offline = false;
      await fireTheTimer();

      expect(waits).toEqual([3_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
      expect(t.server.saved.size).toBe(1);
      expect(t.timers.filter((timer) => !timer.cleared)).toEqual([]);
    });

    it("starts over from the shortest wait when something says the connection may be back", async () => {
      const t = setup();
      await t.queue.start();
      t.server.offline = true;
      await t.queue.submit(income(), "ivan");
      for (let i = 0; i < 3; i++) {
        const [pending] = t.timers.filter((timer) => !timer.cleared);
        pending!.cleared = true;
        pending!.callback();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(t.timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([60_000]);

      await t.queue.nudge();

      // Still offline: one failure again, so the shortest wait.
      expect(t.timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([3_000]);
    });

    it("stops by itself once everything is sent", async () => {
      const t = setup();
      await t.queue.start();
      t.server.offline = true;
      await t.queue.submit(income(), "ivan");
      t.server.offline = false;

      await t.queue.nudge();

      expect(t.timers.filter((timer) => !timer.cleared)).toEqual([]);
    });
  });

  describe("when the phone gives no storage", () => {
    const brokenStore = () => ({
      list: async () => [] as QueuedEntry[],
      put: async () => {
        throw new Error("no storage");
      },
      remove: async () => {
        throw new Error("no storage");
      },
    });

    it("still sends the entry when the server answers", async () => {
      const t = setup({ store: brokenStore() });

      const outcome = await t.queue.submit(income(), "ivan");

      expect(outcome.kind).toBe("saved");
      expect(t.server.saved.size).toBe(1);
    });

    it("says that the entry is kept nowhere when the server does not answer, so the form can keep it", async () => {
      const t = setup({ store: brokenStore() });
      t.server.offline = true;

      const outcome = await t.queue.submit(income(), "ivan");

      expect(outcome).toEqual({ kind: "not-kept", why: "offline" });
    });
  });

  it("tells other tabs when the stored entries change", async () => {
    let changes = 0;
    const t = setup({ onStoreChanged: () => changes++ });
    t.server.offline = true;
    await t.queue.submit(income(), "ivan");
    const afterWrite = changes;
    t.server.offline = false;

    await t.queue.nudge();

    expect(afterWrite).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(afterWrite);
  });

  it("finds on the phone what an earlier visit left there", async () => {
    const store = memoryStore();
    const entry = income();
    await store.put({ id: entry.id, input: entry, login: "ivan", queuedAt: "2026-03-05T08:00:00.000Z", status: "waiting", problem: null });
    const t = setup({ store });
    t.server.log.length = 0;

    await t.queue.start();
    expect(t.queue.getState().entries.map((item) => item.id)).toEqual([entry.id]);
    await t.queue.nudge();

    expect(t.server.saved.has(entry.id)).toBe(true);
    expect(await t.stored()).toEqual([]);
  });
});

describe("the entries on the phone (IndexedDB)", () => {
  const entry = (id: string, queuedAt: string): QueuedEntry => ({
    id,
    input: { type: "income", id, amountMinor: 100, currency: "RUB", clientCode: "K1" },
    login: "ivan",
    queuedAt,
    status: "waiting",
    problem: null,
  });

  it("keeps entries across closing and opening the app, oldest first", async () => {
    const factory = new IDBFactory();
    const first = indexedDbStore(factory);
    // Ids that sort the other way round than the times: the order is the time of writing, not the id.
    await first.put(entry("b", "2026-03-05T08:31:00.000Z"));
    await first.put(entry("c", "2026-03-05T08:30:00.000Z"));
    await first.put(entry("a", "2026-03-05T08:32:00.000Z"));

    const reopened = indexedDbStore(factory);

    expect((await reopened.list()).map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("replaces an entry with the same id, and forgets one that is removed", async () => {
    const store = indexedDbStore(new IDBFactory());
    await store.put(entry("a", "2026-03-05T08:30:00.000Z"));
    await store.put({ ...entry("a", "2026-03-05T08:30:00.000Z"), status: "blocked", problem: { kind: "rejected" } });
    await store.put(entry("b", "2026-03-05T08:31:00.000Z"));

    await store.remove("b");

    const [left] = await store.list();
    expect(await store.list()).toHaveLength(1);
    expect(left).toMatchObject({ id: "a", status: "blocked", problem: { kind: "rejected" } });
  });

  it("works under the queue the way the memory store does", async () => {
    const t = setup({ store: indexedDbStore(new IDBFactory()) });
    t.server.offline = true;
    const kept = income(70_000);
    await t.queue.submit(kept, "ivan");
    expect(await t.stored()).toEqual([kept.id]);
    t.server.offline = false;

    await t.queue.nudge();

    expect(t.server.saved.has(kept.id)).toBe(true);
    expect(await t.stored()).toEqual([]);
  });
});
