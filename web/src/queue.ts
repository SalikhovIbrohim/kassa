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
 *   made them: the server takes the author from the session. The login is checked again before every
 *   send, and sent along, so that a session of somebody else (another tab, a sign-in that happened
 *   while a send was under way) is refused by the server and never gets the entry.
 * - A new entry does not overtake older ones that are waiting: money that came in earlier counts first.
 * - An entry the server refuses for what it says (data it cannot take, say) is not dropped and not
 *   sent again forever: it stays, marked with the reason, until the cashier decides.
 */

/** Why the server did not take an entry. */
export type Problem =
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
  /** The session has ended (or is somebody else's): entries wait until the cashier signs in again. */
  needsLogin: boolean;
  /** When the server was last tried (ISO time), whatever came of it; null before the first try. */
  triedAt: string | null;
};

/** What became of an entry that was sent right away (what a form needs to know). */
export type SendOutcome =
  | { kind: "saved"; operation: Operation; balances: Balance[] }
  /**
   * On the phone, and it goes out by itself when the server can be reached (or after signing in).
   * `slow`: the server has not answered yet; the send goes on, and the form need not wait for it.
   */
  | { kind: "kept"; why: "offline" | "server" | "login" | "slow" }
  /** The server said no for what the entry says. It is not kept: the form shows why. */
  | { kind: "refused"; problem: Problem }
  /** The phone's storage did not take it, and sending did not work: only the form still has it. */
  | { kind: "not-kept"; why: "offline" | "server" | "login" }
  /** Another entry with this id is still on the phone: this one was not taken, and it did not replace that one. */
  | { kind: "busy" };

export type QueueDeps = {
  store: QueueStore;
  /** `login` is whose entry it is: it goes along, and the server refuses it under another session. */
  send: (input: OperationInput, login: string) => Promise<OperationResult>;
  /** The cashier signed in now, or null. */
  currentLogin: () => string | null;
  now?: () => Date;
  /** Told about the balances the server reported after an entry was saved, and which entry it was. */
  onSaved?: (balances: Balance[], operation: Operation) => void;
  /** Told when the stored entries changed, so that other tabs can load them again. */
  onStoreChanged?: () => void;
  /** When to try again after failures, in milliseconds, by number of failures in a row. */
  retryDelays?: number[];
  /** How long a form waits for the server before it is told that the entry is safe on the phone. */
  patienceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Runs `work` while no other tab does the same (Web Locks); the same tab one after another. */
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
};

const DEFAULT_RETRY_DELAYS = [3_000, 10_000, 30_000, 60_000];
const DEFAULT_PATIENCE_MS = 3_000;

export type Queue = ReturnType<typeof createQueue>;

export function createQueue(deps: QueueDeps) {
  const now = deps.now ?? (() => new Date());
  const retryDelays = deps.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const patienceMs = deps.patienceMs ?? DEFAULT_PATIENCE_MS;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const exclusive = deps.exclusive ?? ((work) => work());

  let state: QueueState = { entries: [], sending: false, offline: false, needsLogin: false, triedAt: null };
  const listeners = new Set<() => void>();
  let failures = 0;
  let timer: unknown;
  let started = false;
  // One send at a time in this tab, whoever asks.
  let tail: Promise<unknown> = Promise.resolve();
  // Counts the writes to the phone's storage, so that a read that began before one can tell.
  let writes = 0;
  // The last read of the phone's storage failed: what is on the phone may be more than is known here.
  let unread = false;
  // What became of the entries that a form is waiting for, whichever run sent them: a run that was already
  // under way sends an entry made after it began, and the run of the entry itself then finds nothing to send.
  const awaited = new Map<string, SendOutcome | undefined>();

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

  /**
   * Reads the stored entries. A write that happened while the storage was being read makes the answer
   * old, and it would hide the new entry: then it is read again.
   */
  async function reload() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = writes;
      let entries: QueuedEntry[];
      try {
        entries = await deps.store.list();
      } catch (error) {
        // There may be entries on the phone that are not known here: it is looked at again in a while.
        unread = true;
        failures++;
        throw error;
      }
      if (writes === before) {
        unread = false;
        setState({ entries });
        return;
      }
    }
  }

  function waitingFor(login: string): QueuedEntry[] {
    return state.entries.filter((entry) => entry.login === login && entry.status === "waiting");
  }

  function scheduleRetry() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const login = deps.currentLogin();
    if (!started || !login || state.needsLogin || (waitingFor(login).length === 0 && !unread)) return;
    // After the first failure the first delay, and so on, staying at the last one.
    const delay = retryDelays[Math.min(Math.max(failures - 1, 0), retryDelays.length - 1)] ?? 60_000;
    timer = setTimer(() => {
      timer = undefined;
      void drain();
    }, delay);
  }

  async function put(entry: QueuedEntry) {
    writes++;
    await deps.store.put(entry);
    setState({
      entries: state.entries.some((item) => item.id === entry.id)
        ? state.entries.map((item) => (item.id === entry.id ? entry : item))
        : [...state.entries, entry],
    });
    deps.onStoreChanged?.();
  }

  async function drop(id: string) {
    writes++;
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
  async function attempt(entry: Pick<QueuedEntry, "id" | "input" | "login">): Promise<SendOutcome> {
    let result: OperationResult;
    try {
      result = await deps.send(entry.input, entry.login);
      setState({ triedAt: now().toISOString() });
    } catch (error) {
      setState({ triedAt: now().toISOString() });
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
      // Told first: a form that was waiting for this entry looks for it on the phone, and must hear that it
      // was saved before it sees it gone. If the storage cannot forget it, the entry is sent again later and
      // the server answers "already saved".
      deps.onSaved?.(result.balances, result.operation);
      await drop(entry.id).catch(() => {});
      return { kind: "saved", operation: result.operation, balances: result.balances };
    }

    if (result.reason === "session-expired" || result.reason === "wrong-session") {
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
      case "conflict":
        return { kind: "refused", problem: { kind: "conflict" } };
      case "forbidden":
        return { kind: "refused", problem: { kind: "forbidden" } };
      case "rejected":
        return { kind: "refused", problem: { kind: "rejected" } };
    }
  }

  /**
   * Sends every waiting entry of `login`, oldest first, and stops at the first that cannot reach the server
   * or when somebody else has signed in. `typed` is an entry made just now: what became of it is returned
   * (a refusal is not recorded on it, the form shows why), and `unstored` is it again when the phone
   * could not keep it, so that it is sent last all the same.
   */
  async function sendInOrder(login: string, typed?: string, unstored?: QueuedEntry): Promise<SendOutcome | undefined> {
    let typedOutcome: SendOutcome | undefined;
    const stop = (outcome: SendOutcome) => (typed === undefined ? undefined : (typedOutcome ?? outcome));
    try {
      await reload();
    } catch (error) {
      // The entries could not be read: those in memory are all there is to go on with.
      console.error("The entries on the phone could not be read:", error);
    }
    setState({ sending: true });
    try {
      const line = [...waitingFor(login), ...(unstored ? [unstored] : [])];
      for (const entry of line) {
        if (deps.currentLogin() !== login) return stop({ kind: "kept", why: "login" });
        const outcome = await attempt(entry);
        if (entry.id === typed) typedOutcome = outcome;
        if (awaited.has(entry.id)) awaited.set(entry.id, outcome);
        if (outcome.kind === "kept") return stop(outcome);
        // A refusal of the entry just typed is not recorded on it: the form shows why.
        if (outcome.kind === "refused" && entry.id !== typed) {
          await put({ ...entry, status: "blocked", problem: outcome.problem });
        }
      }
      return typedOutcome;
    } finally {
      setState({ sending: false });
      scheduleRetry();
    }
  }

  // Asks for the entries to be sent while one run is under way: they are worked through once more
  // when it is over, not once for every ask.
  let draining: Promise<void> | null = null;
  let drainAgain = false;

  /** Never rejects: a failing storage must not take the app down, and the entries are still on the phone. */
  function drain(): Promise<void> {
    if (draining) {
      drainAgain = true;
      return draining;
    }
    draining = (async () => {
      try {
        do {
          drainAgain = false;
          const login = deps.currentLogin();
          if (!login) break;
          await serial(() => sendInOrder(login)).catch((error) => {
            console.error("The queue could not be worked through:", error);
          });
        } while (drainAgain);
      } finally {
        draining = null;
        scheduleRetry();
      }
    })();
    return draining;
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
      try {
        await reload();
      } finally {
        scheduleRetry();
      }
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
     * Writes an entry to the phone and sends it right away, after the entries that are waiting and were
     * made before it. The form waits for the outcome: saved (the usual case), refused (the form shows
     * why; the entry is not kept), or kept (no connection, or no answer yet: safe on the phone, and it
     * goes out by itself).
     */
    async submit(input: OperationInput, login: string): Promise<SendOutcome> {
      // The two forms share the id until the entry is answered. Another entry with it, still on its way, is not
      // ours to replace: writing over it would lose what the cashier typed first.
      const taken = state.entries.find((item) => item.id === input.id);
      if (taken && JSON.stringify(taken.input) !== JSON.stringify(input)) return { kind: "busy" };

      const entry: QueuedEntry = {
        id: input.id,
        input,
        login,
        queuedAt: now().toISOString(),
        status: "waiting",
        problem: null,
      };
      awaited.set(entry.id, undefined);
      let stored = true;
      try {
        await put(entry);
      } catch {
        stored = false;
      }

      const sent = serial(() => sendInOrder(login, entry.id, stored ? undefined : entry)).then(
        (outcome): SendOutcome => {
          const known: SendOutcome = outcome ?? awaited.get(entry.id) ?? { kind: "kept", why: "server" };
          awaited.delete(entry.id);
          return known;
        },
        (error): SendOutcome => {
          // Whatever went wrong inside, the entry is where it was put: on the phone, or only in the form.
          console.error("The entry could not be sent:", error);
          awaited.delete(entry.id);
          return { kind: "kept", why: "server" };
        },
      );

      // A server that does not answer must not hold the form: the entry is safe on the phone, and the send goes on.
      let outcome: SendOutcome;
      let impatient: unknown;
      if (stored) {
        const slow = new Promise<SendOutcome>((resolve) => {
          impatient = setTimer(() => resolve({ kind: "kept", why: "slow" }), patienceMs);
        });
        outcome = await Promise.race([sent, slow]);
        if (impatient !== undefined) clearTimer(impatient);
        if (outcome.kind === "kept" && outcome.why === "slow") {
          // Nobody is waiting for the answer now: a refusal that comes later has to be shown by the queue.
          void sent.then(async (late) => {
            if (late.kind === "refused") {
              const current = state.entries.find((item) => item.id === entry.id);
              if (current) await put({ ...current, status: "blocked", problem: late.problem }).catch(() => {});
            }
          });
          scheduleRetry();
          return outcome;
        }
      } else {
        outcome = await sent;
      }

      if (outcome.kind === "refused" && stored) await drop(entry.id).catch(() => {});
      if (outcome.kind === "kept") {
        if (!stored) return { kind: "not-kept", why: outcome.why === "slow" ? "server" : outcome.why };
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
