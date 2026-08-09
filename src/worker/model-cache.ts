/**
 * IndexedDB-backed model-blob cache for the worker.
 *
 * Stores the binary model weights the worker needs at runtime: the
 * Granite-Docling structure model and the per-script OCR recognition models
 * (latin, arabic, cyrillic, …). Detection is language-agnostic (one model);
 * recognition is per-script, so several model blobs can live here side by side.
 *
 * Browser-only at runtime, but **safe to import in Node**: when `indexedDB` is
 * undefined every read returns a miss, every write is a no-op, and no API ever
 * throws. That guard is what lets the whole worker bundle be imported and
 * unit-tested in Node before a browser (or `fake-indexeddb`) is present.
 *
 * Layout: one database (`"liteparse-models"`), one object store (`"models"`)
 * with **out-of-line** composite keys shaped `${id}@${version}`, plus a
 * secondary `"by-id"` index so {@link invalidate} / {@link listModels} can range
 * over every version of one model without a full scan.
 *
 * See ARCHITECTURE.md → Web Worker Architecture (model lifecycle).
 */

/** Reference to a cached model (id + version pair). */
export interface ModelRef {
  id: string;
  version: string;
}

const DB_NAME = "liteparse-models";
const DB_VERSION = 1;
const STORE = "models";
/** Secondary index over the value's `id` field (non-unique). */
const BY_ID = "by-id";

/** Row persisted in the object store. `blob` is always normalized to bytes. */
interface ModelRecord {
  id: string;
  version: string;
  blob: Uint8Array;
  storedAt: number;
}

/** Build the out-of-line composite key for one model version. */
function keyOf(id: string, version: string): string {
  return `${id}@${version}`;
}

/** True when an IndexedDB implementation exists on this global. */
function idbAvailable(): boolean {
  return (
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined"
  );
}

// Cached connection. `undefined` (not yet opened, or unavailable) vs a promise
// that resolves to the DB. On a failed open the cache is reset so the next call
// can retry rather than replaying the same rejection forever.
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Lazily open (and memoize) the database connection. Returns a rejected promise
 * if the open itself fails; callers that need the no-throw node behavior must
 * check {@link idbAvailable} first (the public APIs below all do).
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const indexedDB = (globalThis as { indexedDB: IDBFactory }).indexedDB;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Out-of-line keys: we pass the composite key explicitly on put/get,
        // so the value shape stays exactly { id, version, blob, storedAt }.
        const store = db.createObjectStore(STORE);
        store.createIndex(BY_ID, "id", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another connection opens a higher DB version, release this handle so
      // the upgrade can proceed, and reset the memo so the next call reopens fresh
      // (otherwise we'd hand out a force-closed, stale IDBDatabase handle).
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  }).catch((err) => {
    // Drop the cached rejection so a later call can retry the open.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Resolve an IDBRequest into a promise. */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/** Resolve a readwrite transaction's lifetime into a promise. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}

/** Normalize Blob | Uint8Array input into bytes. Blobs are read once at write
 *  time so reads are always synchronous bytes. */
async function toBytes(data: Uint8Array | Blob): Promise<Uint8Array> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return data;
}

/**
 * Does a cached copy of `(id, version)` exist?
 * Returns `false` (never throws) when IndexedDB is unavailable.
 */
export async function hasModel(id: string, version: string): Promise<boolean> {
  if (!idbAvailable()) return false;
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const record: ModelRecord | undefined = await reqToPromise(
    tx.objectStore(STORE).get(keyOf(id, version)),
  );
  return record !== undefined;
}

/**
 * Fetch the bytes for `(id, version)`, or `undefined` on miss.
 * Returns `undefined` (never throws) when IndexedDB is unavailable.
 * The returned array is a structured-clone copy, not the live stored buffer.
 */
export async function getModel(
  id: string,
  version: string,
): Promise<Uint8Array | undefined> {
  if (!idbAvailable()) return undefined;
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const record: ModelRecord | undefined = await reqToPromise(
    tx.objectStore(STORE).get(keyOf(id, version)),
  );
  return record ? record.blob : undefined;
}

/**
 * Store `data` under `(id, version)`, overwriting any prior version. Accepts a
 * {@link Uint8Array} or a {@link Blob}; a Blob is converted to bytes once, at
 * write time, so subsequent reads always return {@link Uint8Array}.
 * No-op (never throws) when IndexedDB is unavailable.
 */
export async function putModel(
  id: string,
  version: string,
  data: Uint8Array | Blob,
): Promise<void> {
  if (!idbAvailable()) return;
  const bytes = await toBytes(data);
  const record: ModelRecord = {
    id,
    version,
    blob: bytes,
    storedAt: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record, keyOf(id, version));
  await txDone(tx);
}

/**
 * Delete **every** version of `id` (uses the by-id index so it is O(matches),
 * not a full scan). No-op (never throws) when IndexedDB is unavailable.
 */
export async function invalidate(id: string): Promise<void> {
  if (!idbAvailable()) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const index = tx.objectStore(STORE).index(BY_ID);
  const cursorReq = index.openCursor(IDBKeyRange.only(id));
  await new Promise<void>((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor: IDBCursorWithValue | null = cursorReq.result;
      if (cursor) {
        cursor.delete(); // deletes the record at this cursor position
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () =>
      reject(cursorReq.error ?? new Error("indexedDB cursor failed"));
  });
  await txDone(tx);
}

/**
 * List every cached model as `{ id, version }`.
 * Returns `[]` (never throws) when IndexedDB is unavailable.
 */
export async function listModels(): Promise<ModelRef[]> {
  if (!idbAvailable()) return [];
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const all: ModelRecord[] = await reqToPromise(tx.objectStore(STORE).getAll());
  return all.map((r) => ({ id: r.id, version: r.version }));
}

/**
 * Request durable persistent storage so the cache survives eviction. Returns
 * `true` if persistence was granted (or already granted), `false` if the API is
 * unavailable or declined. Never throws.
 */
export async function requestPersistent(): Promise<boolean> {
  const storage = (
    globalThis as {
      navigator?: { storage?: { persist?: () => Promise<boolean> } };
    }
  ).navigator?.storage;
  const persist = storage?.persist;
  if (typeof persist !== "function") return false;
  try {
    return Boolean(await persist.call(storage));
  } catch {
    return false;
  }
}
