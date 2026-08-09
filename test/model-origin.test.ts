/**
 * Tests for src/worker/model-origin.ts — the S3 fetch seam + read-through cache.
 *
 * Uses fake-indexeddb (registered exactly like model-cache.test.ts) so resolveModel's
 * local tier is real. The origin is a fake whose `fetchModel` we spy on.
 */
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createThrowModelOrigin,
  ModelFetchError,
  resolveModel,
} from "../src/worker/model-origin.js";
import type { ModelDescriptor, ModelOrigin } from "../src/worker/model-origin.js";
import { invalidate, listModels } from "../src/worker/model-cache.js";
import * as modelCache from "../src/worker/model-cache.js";

beforeAll(() => {
  const g = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown };
  g.indexedDB = indexedDB;
  g.IDBKeyRange = IDBKeyRange;
});

afterEach(async () => {
  const refs = await listModels();
  for (const r of refs) await invalidate(r.id);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function descriptor(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id: "granite-docling", version: "1.0.0", ...over };
}

function fakeOrigin(bytes: Uint8Array): ModelOrigin & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async fetchModel(): Promise<Uint8Array> {
      calls++;
      return bytes;
    },
  };
}

describe("resolveModel read-through", () => {
  it("returns cached bytes on a hit without calling the origin", async () => {
    const origin = fakeOrigin(new Uint8Array([1, 2, 3]));
    // Prime the cache by a first miss.
    await resolveModel(descriptor(), origin);
    expect(origin.calls).toBe(1);

    // Second call is a cache hit → origin never touched again.
    const got = await resolveModel(descriptor(), origin);
    expect(origin.calls).toBe(1);
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("fetches from the origin on a miss and writes through to the cache", async () => {
    const origin = fakeOrigin(new Uint8Array([9, 9, 9, 9]));
    const desc = descriptor({ id: "fresh-model", version: "0.2.0" });

    const got = await resolveModel(desc, origin);
    expect(origin.calls).toBe(1);
    expect(got).toEqual(new Uint8Array([9, 9, 9, 9]));

    // Write-through: a brand-new origin with zero calls still resolves from cache.
    const untouched = fakeOrigin(new Uint8Array([0]));
    const cached = await resolveModel(desc, untouched);
    expect(untouched.calls).toBe(0);
    expect(cached).toEqual(new Uint8Array([9, 9, 9, 9]));
  });

  it("wraps a non-ModelFetchError origin failure into a ModelFetchError (cause preserved)", async () => {
    const origin: ModelOrigin = {
      async fetchModel(): Promise<Uint8Array> {
        throw new Error("S3 403");
      },
    };
    try {
      await resolveModel(descriptor({ id: "err-model", version: "1" }), origin);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelFetchError);
      expect((err as Error).message).toContain("err-model");
      expect((err as Error).message).toContain("1");
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
    }
  });

  it("propagates a ModelFetchError thrown by the origin as-is", async () => {
    const origin: ModelOrigin = {
      async fetchModel(): Promise<Uint8Array> {
        throw new ModelFetchError("direct model-fetch error");
      },
    };
    await expect(
      resolveModel(descriptor({ id: "direct", version: "1" }), origin),
    ).rejects.toThrow("direct model-fetch error");
  });

  it("does not cache on an origin failure (next call still hits the origin)", async () => {
    let calls = 0;
    const origin: ModelOrigin = {
      async fetchModel(): Promise<Uint8Array> {
        calls++;
        throw new ModelFetchError("nope");
      },
    };
    const desc = descriptor({ id: "fail-once", version: "1" });
    await expect(resolveModel(desc, origin)).rejects.toThrow("nope");
    await expect(resolveModel(desc, origin)).rejects.toThrow("nope");
    expect(calls).toBe(2); // not cached → both calls reached the origin
  });

  it("dedups concurrent cold-cache fetches to a single origin call (single-flight) (P4 / R3-M)", async () => {
    let calls = 0;
    const bytes = new Uint8Array([7, 7, 7]);
    const origin: ModelOrigin & { calls: number } = {
      get calls() {
        return calls;
      },
      async fetchModel(): Promise<Uint8Array> {
        calls++;
        // Slow origin download so the second call arrives while the first is in-flight.
        await new Promise((r) => setTimeout(r, 20));
        return bytes;
      },
    };
    const desc = descriptor({ id: "concurrent", version: "1" });
    const [a, b] = await Promise.all([
      resolveModel(desc, origin),
      resolveModel(desc, origin),
    ]);
    expect(origin.calls).toBe(1);
    expect(a).toEqual(bytes);
    expect(b).toEqual(bytes);
  });

  it("returns the fetched bytes even when the cache write fails (quota) — best-effort write-through (P4 / R3-B)", async () => {
    const origin = fakeOrigin(new Uint8Array([5, 6, 7, 8]));
    const desc = descriptor({ id: "quota-model", version: "1" });
    // Force the local-tier write to fail (e.g. QuotaExceededError). resolveModel must
    // still return the freshly fetched bytes — a cache problem can't discard them.
    const putSpy = vi
      .spyOn(modelCache, "putModel")
      .mockRejectedValue(new DOMException("quota", "QuotaExceededError"));
    try {
      const got = await resolveModel(desc, origin);
      expect(origin.calls).toBe(1);
      expect(putSpy).toHaveBeenCalled();
      expect(got).toEqual(new Uint8Array([5, 6, 7, 8]));
    } finally {
      putSpy.mockRestore();
    }
  });
});

describe("createThrowModelOrigin", () => {
  it("rejects every fetch with a ModelFetchError", async () => {
    const origin = createThrowModelOrigin();
    await expect(origin.fetchModel(descriptor())).rejects.toBeInstanceOf(ModelFetchError);
  });
});
