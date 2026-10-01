import { NetworkError, type Balance, type Operation, type OperationInput, type OperationResult } from "./api";
import type { Currency } from "./money";

/**
 * Entries made while the phone has no connection, kept on the phone until the server has them.
 *
 * The rules this file keeps:
 * - An entry is written to the phone's storage BEFORE it is sent, so neither a lost connection
 *   nor a closed app can lose it.
 * - Every entry has its id from the start and keeps it. The server saves an id once, so
 *   sending again after an answer was lost never counts anything twice.
 * - Entries go out one at a time, oldest first, and only under the login of the cashier who
 *   made them: the server takes the author from the session, so another cashier's session
 *   must never send them.
 * - An entry the server refuses for what it says (not enough money, say) is not dropped and not
 *   sent again forever: it stays, marked with the reason, until the cashier decides.
 */

/** Why the server did not take an entry. */
export type Problem =
  | { kind: "insufficient-balance"; currency: Currency; availableMinor: number }
  | { kind: "conflict" }
  | { kind: "rejected" }
  | { kind: "forbidden" };

export type QueuedEntry = {
  /** The id of the operation: the entry's identity everywhere. */
  id: string;
  input: OperationInput;
  /** The cashier who made it. */
  login: string;
  queuedAt: string;
  /** `waiting` goes out by itself; `blocked` waits for the cashier (see `problem`). */
  status: "waiting" | "blocked";
  problem: Problem | null;
};

/** Where entries are kept. IndexedDB on the phone; memory in tests. */
export interface QueueStore {
  /** Oldest first. */
  list(): Promise<QueuedEntry[]>;
  put(entry: QueuedEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

export type QueueState = {
  entries: QueuedEntry[];
  /** A send is in progress. */
  sending: boolean;
  /** The last try did not reach the server: the phone is most likely offline. */
  offline: boolean;
  /** The session has ended: entries wait until the cashier signs in again. */
  needsLogin: boolean;
};

/** What became of an entry that was sent right away (what a form needs to know). */
export type SendOutcome =
  | { kind: "saved"; operation: Operation; balances: Balance[] }
  /** On the phone, and it goes out by itself when the server can be reached (or after signing in). */
  | { kind: "kept"; why: "offline" | "server" | "login" }
  /** The server said no for what the entry says. It is not kept: the form shows why. */
  | { kind: "refused"; problem: Problem }
  /** The phone's storage did not take it, and sending did not work: only the form still has it. */
  | { kind: "not-kept"; why: "offline" | "server" | "login" };

export type QueueDeps = {
  store: QueueStore;
  send: (input: OperationInput) => Promise<OperationResult>;
  /** The cashier signed in now, or null. */
  currentLogin: () => string | null;
  now?: () => Date;
  /** Told about the balances the server reported after an entry was saved. */
  onSaved?: (balances: Balance[]) => void;
  /** Told when the stored entries changed, so that other tabs can load them again. */
  onStoreChanged?: () => void;
  /** When to try again after failures, in milliseconds, by number of failures in a row. */
  retryDelays?: number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Runs `work` while no other tab does the same (Web Locks); the same tab one after another. */
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
};

const DEFAULT_RETRY_DELAYS = [3_000, 10_000, 30_000, 60_000];

export type Queue = ReturnType<typeof createQueue>;

export function createQueue(deps: QueueDeps) {
  const now = deps.now ?? (() => new Date());
  const retryDelays = deps.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const exclusive = deps.exclusive ?? ((work) => work());

  let state: QueueState = { entries: [], sending: false, offline: false, needsLogin: false };
  const listeners = new Set<() => void>();
  let failures = 0;
  let timer: unknown;
  let started = false;
  // One send at a time in this tab, whoever asks.
  let tail: Promise<unknown> = Promise.resolve();

  function setState(patch: Partial<QueueState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  /** Runs `work` after everything asked for before it, one at a time, also across tabs. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(() => exclusive(work));
    tail = run.catch(() => {});
    return run;
  }

  async function reload() {
    setState({ entries: await deps.store.list() });
  }

  function waitingFor(login: string): QueuedEntry[] {
    return state.entries.filter((entry) => entry.login === login && entry.status === "waiting");
  }

  function scheduleRetry() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const login = deps.currentLogin();
    if (!started || !login || state.needsLogin || waitingFor(login).length === 0) return;
    // After the first failure the first delay, and so on, staying at the last one.
    const delay = retryDelays[Math.min(Math.max(failures - 1, 0), retryDelays.length - 1)] ?? 60_000;
    timer = setTimer(() => {
      timer = undefined;
      void drain();
    }, delay);
  }

  async function put(entry: QueuedEntry) {
    await deps.store.put(entry);
    setState({
      entries: state.entries.some((item) => item.id === entry.id)
        ? state.entries.map((item) => (item.id === entry.id ? entry : item))
        : [...state.entries, entry],
    });
    deps.onStoreChanged?.();
  }

  async function drop(id: string) {
    try {
      await deps.store.remove(id);
    } finally {
      // Even if the phone's storage failed to forget it: this tab must not show or send it again.
      setState({ entries: state.entries.filter((item) => item.id !== id) });
      deps.onStoreChanged?.();
    }
  }

  /**
   * Sends one entry and says what became of it. It does not throw: the entry stays wherever it is
   * kept unless the server took it or refused it.
   */
  async function attempt(input: OperationInput): Promise<SendOutcome> {
    let result: OperationResult;
    try {
      result = await deps.send(input);
    } catch (error) {
      // No connection, or an answer that could not be read: the entry may or may not have been saved,
      // and sending the same id again is safe either way.
      failures++;
      const unreachable = error instanceof NetworkError;
      if (unreachable) setState({ offline: true });
      return { kind: "kept", why: unreachable ? "offline" : "server" };
    }

    if (result.ok) {
      failures = 0;
      setState({ offline: false });
      // If the storage cannot forget it, the entry is sent again later and the server answers "already saved".
      await drop(input.id).catch(() => {});
      deps.onSaved?.(result.balances);
      return { kind: "saved", operation: result.operation, balances: result.balances };
    }

    if (result.reason === "session-expired") {
      setState({ needsLogin: true });
      return { kind: "kept", why: "login" };
    }
    if (result.reason === "server-error") {
      failures++;
      setState({ offline: false });
      return { kind: "kept", why: "server" };
    }

    // The server answered and said no to what the entry says.
    failures = 0;
    setState({ offline: false });
    switch (result.reason) {
      case "insufficient-balance":
        return {
          kind: "refused",
          problem: { kind: "insufficient-balance", currency: result.currency, availableMinor: result.availableMinor },
        };
      case "conflict":
        return { kind: "refused", problem: { kind: "conflict" } };
      case "forbidden":
        return { kind: "refused", problem: { kind: "forbidden" } };
      case "rejected":
        return { kind: "refused", problem: { kind: "rejected" } };
    }
  }

  /** Sends every waiting entry of the signed-in cashier, oldest first, and stops at the first that cannot reach the server. */
  async function drainNow(): Promise<void> {
    const login = deps.currentLogin();
    if (!login) return;
    await reload();
    setState({ sending: true });
    try {
      for (let pass = 0; pass < 2; pass++) {
        let progressed = false;
        for (const entry of waitingFor(login)) {
          const outcome = await attempt(entry.input);
          if (outcome.kind === "saved") progressed = true;
          else if (outcome.kind === "kept") return;
          else if (outcome.kind === "refused") await put({ ...entry, status: "blocked", problem: outcome.problem });
        }
        if (!progressed || pass === 1) break;
        // Money that came in may now cover an expense that was refused for lack of it: once more.
        for (const entry of state.entries) {
          if (entry.login === login && entry.problem?.kind === "insufficient-balance") {
            await put({ ...entry, status: "waiting", problem: null });
          }
        }
      }
    } finally {
      setState({ sending: false });
      scheduleRetry();
    }
  }

  /** Never rejects: a failing storage must not take the app down, and the entries are still on the phone. */
  function drain(): Promise<void> {
    return serial(drainNow).catch((error) => {
      console.error("The queue could not be worked through:", error);
    });
  }

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Loads what is on the phone, and from now on retries by itself. */
    async start() {
      started = true;
      await reload();
      scheduleRetry();
    },

    stop() {
      started = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },

    /** The connection may be back, the app came to the front, somebody signed in: try now. */
    nudge(): Promise<void> {
      failures = 0;
      if (state.needsLogin && deps.currentLogin()) setState({ needsLogin: false });
      return drain();
    },

    /**
     * Writes an entry to the phone and sends it right away. The form waits for the outcome: saved
     * (the usual case), refused (the form shows why; the entry is not kept), or kept (no connection:
     * safe on the phone, and it goes out by itself).
     */
    async submit(input: OperationInput, login: string): Promise<SendOutcome> {
      const entry: QueuedEntry = {
        id: input.id,
        input,
        login,
        queuedAt: now().toISOString(),
        status: "waiting",
        problem: null,
      };
      let stored = true;
      try {
        await put(entry);
      } catch {
        stored = false;
      }

      const outcome = await serial(async () => {
        setState({ sending: true });
        try {
          return await attempt(input);
        } finally {
          setState({ sending: false });
        }
      });

      if (outcome.kind === "refused" && stored) await drop(input.id).catch(() => {});
      if (outcome.kind === "kept") {
        if (!stored) return { kind: "not-kept", why: outcome.why };
        scheduleRetry();
      }
      return outcome;
    },

    /** The cashier asks to try a blocked entry again. */
    async retry(id: string): Promise<void> {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) return;
      await put({ ...entry, status: "waiting", problem: null });
      await drain();
    },

    /** The cashier gives an entry up: it is removed from the phone for good. */
    async discard(id: string): Promise<void> {
      await drop(id);
    },

    /** Loads the entries again (another tab changed them). */
    reload,
  };
}
