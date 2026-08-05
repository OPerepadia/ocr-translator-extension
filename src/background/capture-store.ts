// Screen captures outlive the request that took them: the overlay asks for a
// display copy afterwards, and a language switch re-reads the original pixels.
// Neither can count on the background still being alive, so the pixels go to
// IndexedDB — the one store both browsers keep Blobs in verbatim.

export interface CaptureRecord {
  /** Checked before a late write from a superseded capture overwrites a newer
   * one. */
  requestId: string;
  image?: Blob;
  /** CSS size of the region the capture covers, which sets the resolution its
   * display copy is encoded at. Absent for a context-menu image, whose rendered
   * size the content script keeps to itself. */
  displaySize?: { width: number; height: number };
  sourceLanguage: string;
  updatedAt: number;
}

export type CaptureDraft = Omit<CaptureRecord, "updatedAt">;

export interface CaptureStore {
  get(frameKey: string): Promise<CaptureRecord | undefined>;
  /** Read-modify-write. `mutate` sees the current record (absent if never
   * written or expired); returning undefined leaves the store untouched. */
  update(
    frameKey: string,
    mutate: (current: CaptureRecord | undefined) => CaptureDraft | undefined,
  ): Promise<void>;
}

const DB_NAME = "screen-ocr-translator";
const DB_VERSION = 1;
const STORE_NAME = "captures";
const UPDATED_AT_INDEX = "updatedAt";

// Bounds on how long abandoned multi-megabyte screenshots pile up. Whichever
// is hit first evicts the oldest.
export const MAX_CAPTURES = 8;
export const CAPTURE_TTL_MS = 30 * 60_000;

export interface CaptureStoreOptions {
  factory?: IDBFactory;
  now?: () => number;
}

export function createCaptureStore(
  options: CaptureStoreOptions = {},
): CaptureStore {
  const factory = options.factory ?? indexedDB;
  const now = options.now ?? Date.now;
  let connecting: Promise<IDBDatabase> | undefined;

  function connect(): Promise<IDBDatabase> {
    connecting ??= openDatabase(factory).catch((error: unknown) => {
      // Let the next call retry rather than caching the failure forever.
      connecting = undefined;
      throw error;
    });
    return connecting;
  }

  function unexpired(record: CaptureRecord | undefined) {
    return record && record.updatedAt > now() - CAPTURE_TTL_MS
      ? record
      : undefined;
  }

  return {
    async get(frameKey) {
      const database = await connect();
      const transaction = database.transaction(STORE_NAME, "readonly");
      const record = (await promisify(
        transaction.objectStore(STORE_NAME).get(frameKey),
      )) as CaptureRecord | undefined;
      await settled(transaction);
      return unexpired(record);
    },

    async update(frameKey, mutate) {
      const database = await connect();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const current = (await promisify(store.get(frameKey))) as
        | CaptureRecord
        | undefined;

      const next = mutate(unexpired(current));
      if (next) {
        store.put({ ...next, updatedAt: now() }, frameKey);
        await evict(store, now());
      }

      await settled(transaction);
    },
  };
}

/** Never negative: a negative slice end reads as an offset from the end and
 * would evict the records it is meant to spare. */
function excess(count: number): number {
  return Math.max(0, count - MAX_CAPTURES);
}

/** Drop expired records, then the oldest of whatever is left over the cap.
 * Runs inside the caller's write transaction, so it sees that write. */
async function evict(store: IDBObjectStore, currentTime: number): Promise<void> {
  // A key cursor walks the index in updatedAt order without reading values,
  // keeping the captures' Blobs off the heap.
  const entries = await indexEntries(store.index(UPDATED_AT_INDEX));

  const expiresBefore = currentTime - CAPTURE_TTL_MS;
  const live = entries.filter((entry) => {
    if (entry.updatedAt <= expiresBefore) {
      store.delete(entry.primaryKey);
      return false;
    }
    return true;
  });

  for (const entry of live.slice(0, excess(live.length))) {
    store.delete(entry.primaryKey);
  }
}

interface IndexEntry {
  primaryKey: IDBValidKey;
  updatedAt: number;
}

function indexEntries(index: IDBIndex): Promise<IndexEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: IndexEntry[] = [];
    const request = index.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      entries.push({
        primaryKey: cursor.primaryKey,
        updatedAt: cursor.key as number,
      });
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Capture database request failed."));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database
          .createObjectStore(STORE_NAME)
          .createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error("Could not open the capture database."));
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Capture database request failed."));
  });
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error("Capture database transaction failed."),
      );
  });
}
