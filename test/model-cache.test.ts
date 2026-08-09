/**
 * Tests for the IndexedDB-backed model cache.
 *
 * fake-indexeddb is installed by the orchestrator. We import its **typed main
 * entry** (which carries a `types` condition in its `exports` map) and register
 * the two globals the source reads — `indexedDB` and `IDBKeyRange` — on
 * globalThis. This is exactly what the `fake-indexeddb/auto` side-effect import
 * does at runtime, but the `/auto` subpath ships no declaration (no `types`
 * condition, no adjacent `.d.ts`), so importing it directly trips TS7016 under
 * strict + `moduleResolution: bundler`. Manual registration of the typed named
 * exports is equivalent and type-safe.
 */
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getModel,
  hasModel,
  invalidate,
  listModels,
  putModel,
  requestPersistent,
} from "../src/worker/model-cache.js";

// Register the globals model-cache.ts reads (globalThis.indexedDB + the bare
// IDBKeyRange value used in invalidate()). Done once before the suite.
beforeAll(() => {
  const g = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown };
  g.indexedDB = indexedDB;
  g.IDBKeyRange = IDBKeyRange;
});

// Keep tests independent: clear anything the in-memory store retained.
afterEach(async () => {
  const refs = await listModels();
  for (const r of refs) {
    await invalidate(r.id);
  }
});

describe("model-cache round trip", () => {
  it("stores, probes, reads, and lists a model", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await putModel("granite", "1", bytes);

    expect(await hasModel("granite", "1")).toBe(true);

    const got = await getModel("granite", "1");
    expect(got).toBeDefined();
    expect(got).toEqual(bytes);

    const refs = await listModels();
    expect(refs).toContainEqual({ id: "granite", version: "1" });
  });

  it("returns a miss for a version that was never stored", async () => {
    await putModel("granite", "1", new Uint8Array([9]));
    expect(await hasModel("granite", "2")).toBe(false);
    expect(await getModel("granite", "2")).toBeUndefined();
  });

  it("accepts a Blob and returns its bytes on read", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])]);
    await putModel("arabic", "2", blob);

    expect(await hasModel("arabic", "2")).toBe(true);
    expect(await getModel("arabic", "2")).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("overwrites the previous blob when re-putting the same version", async () => {
    await putModel("latin", "0.1", new Uint8Array([1]));
    await putModel("latin", "0.1", new Uint8Array([2, 2]));
    expect(await getModel("latin", "0.1")).toEqual(new Uint8Array([2, 2]));
  });
});

describe("model-cache invalidate", () => {
  it("removes every version of an id but leaves other ids untouched", async () => {
    await putModel("granite", "1", new Uint8Array([1]));
    await putModel("granite", "2", new Uint8Array([2]));
    await putModel("latin", "1", new Uint8Array([3]));

    await invalidate("granite");

    expect(await hasModel("granite", "1")).toBe(false);
    expect(await hasModel("granite", "2")).toBe(false);
    expect(await getModel("granite", "1")).toBeUndefined();

    // other id untouched
    expect(await hasModel("latin", "1")).toBe(true);
    expect(await getModel("latin", "1")).toEqual(new Uint8Array([3]));
  });

  it("is a no-op for an id that was never stored", async () => {
    await putModel("latin", "1", new Uint8Array([4]));
    await expect(invalidate("never-stored")).resolves.toBeUndefined();
    expect(await hasModel("latin", "1")).toBe(true);
  });
});

describe("model-cache node-safety guard", () => {
  const g = globalThis as { indexedDB?: unknown };

  // Restore the registered fake even if an assertion throws.
  afterAll(() => {
    if (g.indexedDB === undefined) {
      g.indexedDB = indexedDB;
    }
  });

  it("returns miss / no-op when indexedDB is absent, never throwing", async () => {
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      // openDb() short-circuits before touching the cached connection.
      expect(await hasModel("anything", "1")).toBe(false);
      expect(await getModel("anything", "1")).toBeUndefined();
      expect(await listModels()).toEqual([]);
      await expect(
        putModel("anything", "1", new Uint8Array([1])),
      ).resolves.toBeUndefined();
      await expect(invalidate("anything")).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) g.indexedDB = saved;
    }
  });

  it("requestPersistent resolves to a boolean and never throws", async () => {
    // No navigator.storage.persist under the vitest node env → false, but the
    // contract is only "boolean, never throws", so assert the type.
    const result = await requestPersistent();
    expect(typeof result).toBe("boolean");
  });
});
