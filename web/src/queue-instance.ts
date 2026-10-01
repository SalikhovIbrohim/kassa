import { useSyncExternalStore } from "react";
import { createOperation, type Balance, type OperationInput } from "./api";
import { createQueue, type QueueState, type SendOutcome } from "./queue";
import { indexedDbStore, memoryStore } from "./queue-store";

/** The cashier who is signed in on this phone now. Entries go out only under this login. */
let signedIn: string | null = null;

export function setQueueLogin(login: string | null) {
  signedIn = login;
}

const savedListeners = new Set<(balances: Balance[]) => void>();

/** Called with the balances whenever an entry from the queue was saved in the background. */
export function onQueuedEntrySaved(listener: (balances: Balance[]) => void): () => void {
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
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kassa-queue") : null;

export const queue = createQueue({
  store: chooseStore(),
  send: createOperation,
  currentLogin: () => signedIn,
  onSaved: (balances) => {
    for (const listener of savedListeners) listener(balances);
  },
  onStoreChanged: () => channel?.postMessage("changed"),
  // One tab sends at a time: two tabs sending the same entry would be harmless (the server keeps an id once) but wasteful.
  exclusive:
    typeof navigator !== "undefined" && navigator.locks
      ? (work) => navigator.locks.request("kassa-queue-send", work)
      : undefined,
});

channel?.addEventListener("message", () => {
  void queue.reload();
});

/** Writes an entry of the signed-in cashier to the phone and sends it right away. */
export function submitEntry(input: OperationInput): Promise<SendOutcome> {
  if (!signedIn) throw new Error("Nobody is signed in");
  return queue.submit(input, signedIn);
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(queue.subscribe, queue.getState);
}
