import type { QueuedEntry, QueueStore } from "./queue";

const DATABASE = "kassa-queue";
const STORE = "entries";

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab with a newer version of the app wants to upgrade: let it.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
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
    database ??= open(factory).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };

  async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await connection()).transaction(STORE, mode);
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
      const all = await inStore("readonly", (store) => store.getAll() as IDBRequest<QueuedEntry[]>);
      return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
    },
    async put(entry) {
      await inStore("readwrite", (store) => store.put(entry));
    },
    async remove(id) {
      await inStore("readwrite", (store) => store.delete(id));
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
