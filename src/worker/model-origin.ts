/**
 * Model origin adapter — the **S3 fetch seam** for the Intelligent Document Router.
 *
 * Model weights are never baked into a runtime. The **origin** is our S3 bucket
 * (CloudFront-fronted, versioned); the **local tier** is IndexedDB
 * (`model-cache.ts`). liteparse owns this contract + the local cache; the consumer
 * injects the concrete S3 implementation (it carries the credentials/SDK), so
 * liteparse stays dependency-free. See ARCHITECTURE.md → "Model Storage & Fetch".
 *
 * Wired in Phase 2 / A8. The worker's engines fetch weights only through
 * {@link resolveModel} (cache read-through), so a warm device never hits the origin.
 */
import { getModel, putModel } from "./model-cache.js";

/** Identifies a model artifact to fetch. `etag` enables a future validate-before-use. */
export interface ModelDescriptor {
  id: string;
  version: string;
  /** Optional etag the origin can use to validate a cached copy without re-downloading. */
  etag?: string;
}

/**
 * Origin of model weights. The consumer implements this against S3/CloudFront (or
 * any HTTP store). liteparse provides {@link createThrowModelOrigin} as the default
 * so an unwired origin fails loudly instead of silently no-op'ing.
 */
export interface ModelOrigin {
  /** Fetch the full model bytes for `descriptor` from the origin. */
  fetchModel(descriptor: ModelDescriptor): Promise<Uint8Array>;
}

/** Thrown when no origin is configured or the origin cannot satisfy a fetch. */
export class ModelFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelFetchError";
  }
}

/**
 * Default origin: rejects every fetch with a clear, actionable error. The consumer
 * MUST inject a real S3-backed origin before any model-bearing strategy runs.
 */
export function createThrowModelOrigin(): ModelOrigin {
  return {
    async fetchModel(): Promise<Uint8Array> {
      throw new ModelFetchError(
        "no ModelOrigin configured — inject an S3-backed origin (see ARCHITECTURE → Model Storage & Fetch)",
      );
    },
  };
}

/**
 * Read-through model fetch: local cache (IndexedDB) first, then the origin, writing
 * the result back to the cache so repeat loads are free. This is the ONLY path the
 * worker's engines should use to obtain weights.
 *
 * Never throws for a cache problem (IndexedDB unavailable, or present but broken
 * ⇒ treated as a miss); only the origin fetch can fail, and that error propagates
 * as a {@link ModelFetchError}. A failed cache *write* (e.g. QuotaExceededError)
 * is best-effort — the freshly fetched bytes are returned regardless, and the next
 * call simply re-fetches.
 *
 * Concurrent calls for the same `(id, version)` share one origin fetch (single-
 * flight), so a cold cache never double-downloads a multi-MB model.
 */
// Per-descriptor inflight fetches, so racing resolveModel() calls dedup to one fetch.
const inflight = new Map<string, Promise<Uint8Array>>();

export async function resolveModel(
  descriptor: ModelDescriptor,
  origin: ModelOrigin,
): Promise<Uint8Array> {
  const key = `${descriptor.id}@${descriptor.version}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<Uint8Array> => {
    // 1. Local tier. A miss is the normal node/unavailable case; a *broken*
    //    IndexedDB (present but unusable — private mode, blocked storage) is
    //    swallowed as a miss too — the cache must never throw here.
    let cached: Uint8Array | undefined;
    try {
      cached = await getModel(descriptor.id, descriptor.version);
    } catch {
      cached = undefined;
    }
    if (cached) return cached;

    // 2. Origin fetch — the only path that can fail hard.
    let bytes: Uint8Array;
    try {
      bytes = await origin.fetchModel(descriptor);
    } catch (err) {
      if (err instanceof ModelFetchError) throw err;
      throw new ModelFetchError(
        `model origin fetch failed for ${descriptor.id}@${descriptor.version}`,
        { cause: err },
      );
    }

    // 3. Write-through to the local tier — best-effort. A quota error (or any
    //    cache-write failure) must NOT discard the bytes we just fetched: the
    //    caller gets the model either way, and the next call re-fetches.
    try {
      await putModel(descriptor.id, descriptor.version, bytes);
    } catch {
      /* cache write is best-effort; the bytes are returned below regardless */
    }
    return bytes;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    // Clear once settled so a later call can retry after a transient failure,
    // and so the entry doesn't pin a large resolved buffer in the Map.
    inflight.delete(key);
  }
}
