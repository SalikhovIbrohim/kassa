import type { QueuedEntry, QueueStore } from "./queue";

const DATABASE = "kassa-queue";
const STORE = "entries";
// A storage that does not answer must not hold up an entry that the server would take: after this
// the write counts as failed (and if it lands later, the entry is sent again and the server says "already saved").
const TIMEOUT_MS = 8_000;

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function open(factory: IDBFactory, onGone: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab with a newer version of the app wants to upgrade: let it. A connection that was
      // closed (by that, or by the browser) is not used again: the next write opens a new one.
      database.onversionchange = () => {
        database.close();
        onGone();
      };
      database.onclose = onGone;
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    // "Blocked" only says that another tab still holds an older version: the request waits and goes on.
  });
}

/**
 * Keeps the entries in IndexedDB: it survives closing the app and restarting the phone, and
 * several tabs of the app share it. A write is not reported until it is committed.
 */
export function indexedDbStore(factory: IDBFactory = indexedDB): QueueStore {
  let database: Promise<IDBDatabase> | undefined;
  const connection = () => {
    // A failed open is tried again next time rather than remembered.
    database ??= within(
      open(factory, () => {
        database = undefined;
      }),
      "Opening the storage",
    ).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };

  async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    // "strict": reported done only when it is really on the disk, not just handed to the system.
    const transaction = (await connection()).transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
    const result = await wrap(work(transaction.objectStore(STORE)));
    await done;
    return result;
  }

  return {
    async list() {
      const all = await within(
        inStore("readonly", (store) => store.getAll() as IDBRequest<QueuedEntry[]>),
        "Reading the entries",
      );
      return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
    },
    async put(entry) {
      await within(
        inStore("readwrite", (store) => store.put(entry)),
        "Writing an entry",
      );
    },
    async remove(id) {
      await within(
        inStore("readwrite", (store) => store.delete(id)),
        "Removing an entry",
      );
    },
  };
}

/** For tests, and as the last resort when the phone gives no storage: lives until the page is closed. */
export function memoryStore(): QueueStore {
  const entries = new Map<string, QueuedEntry>();
  return {
    async list() {
      return [...entries.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
    },
    async put(entry) {
      entries.set(entry.id, structuredClone(entry));
    },
    async remove(id) {
      entries.delete(id);
    },
  };
}
