import { useSyncExternalStore } from "react";
import { createOperation, type Balance, type Operation, type OperationInput } from "./api";
import { createQueue, type QueueState, type SendOutcome } from "./queue";
import { indexedDbStore, memoryStore } from "./queue-store";
import { rememberedShift } from "./remembered-shift";

/** The cashier who is signed in on this phone now. Entries go out only under this login. */
let signedIn: string | null = null;

export function setQueueLogin(login: string | null) {
  signedIn = login;
}

const savedListeners = new Set<(balances: Balance[], operation: Operation) => void>();

/** Called with the balances, and the operation, whenever an entry from the queue was saved in the background. */
export function onQueuedEntrySaved(listener: (balances: Balance[], operation: Operation) => void): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

function chooseStore() {
  try {
    if (typeof indexedDB !== "undefined") return indexedDbStore();
  } catch {
    // fall through
  }
  // No storage on this phone (some private modes): entries live until the page is closed.
  return memoryStore();
}

// Other tabs of the app share the stored entries: when one changes them, the others read them again.
// A browser without it (or one that refuses it) only loses that: the tabs read the entries at their next send.
function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kassa-queue") : null;
  } catch {
    return null;
  }
}
const channel = openChannel();

export const queue = createQueue({
  store: chooseStore(),
  send: createOperation,
  currentLogin: () => signedIn,
  onSaved: (balances, operation) => {
    for (const listener of savedListeners) listener(balances, operation);
  },
  onStoreChanged: () => channel?.postMessage("changed"),
  // One tab sends at a time: two tabs sending the same entry would be harmless (the server keeps an id once) but wasteful.
  exclusive:
    typeof navigator !== "undefined" && navigator.locks
      ? (work) => navigator.locks.request("kassa-queue-send", work)
      : undefined,
});

channel?.addEventListener("message", () => {
  queue.reload().catch(() => {});
});

/**
 * Asks the browser not to clear what this app keeps (the entries that wait) when the phone is short of
 * space. No answer is needed: where it is not granted, nothing changes.
 */
export function keepStorage() {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // not available here
  }
}

/** Writes an entry of the signed-in cashier to the phone and sends it right away. */
export function submitEntry(input: OperationInput): Promise<SendOutcome> {
  if (!signedIn) throw new Error("Nobody is signed in");
  // The shift that is open on this phone now goes with the entry: if it can only be sent later, it still belongs to it.
  const shiftId = rememberedShift(signedIn);
  return queue.submit(shiftId ? { ...input, shiftId } : input, signedIn);
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(queue.subscribe, queue.getState);
}
