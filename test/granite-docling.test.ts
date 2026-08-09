import { describe, expect, it, vi } from "vitest";
import {
  createGraniteDoclingEngine,
  GRANITE_MODEL,
} from "../src/ocr/granite-docling.js";
import type {
  GraniteSession,
  GraniteDoclingOptions,
} from "../src/ocr/granite-docling.js";
import type { OcrContext } from "../src/types.js";

// NOTE: this test file MUST NOT import onnxruntime anywhere — the engine's
// onnxruntime seam is fully mockable and real inference is deferred to P4.

const NON_EMPTY_IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG-ish bytes
const EMPTY_IMAGE = new Uint8Array(0);

function baseCtx(overrides: Partial<OcrContext> = {}): OcrContext {
  return { pageIndex: 0, totalPages: 1, ...overrides };
}

/**
 * A fake GraniteSession whose run() returns a canned outputs object and counts
 * how many times run() / release() were called. The type is widened back to the
 * structural GraniteSession contract where the engine consumes it.
 */
function makeFakeSession(
  outputs: Record<string, unknown> = { tokens: [1, 2, 3] },
): GraniteSession & { runCount: number; releaseCount: number } {
  let runCount = 0;
  let releaseCount = 0;
  const session: GraniteSession & {
    runCount: number;
    releaseCount: number;
  } = {
    async run(_feeds: Record<string, unknown>): Promise<Record<string, unknown>> {
      runCount += 1;
      return outputs;
    },
    release(): void {
      releaseCount += 1;
    },
    get runCount(): number {
      return runCount;
    },
    get releaseCount(): number {
      return releaseCount;
    },
  };
  return session;
}

/** Build a GraniteDoclingOptions with fully-injected (mockable) seams. Returns the
 *  mock fns so each test can assert call counts. */
function makeMocked(
  overrides: {
    mode?: "browser" | "edge";
    hasWebGPU?: boolean;
    postResult?: { text: string; confidence?: number };
  } = {},
) {
  const session = makeFakeSession();
  const factory = vi.fn(async (): Promise<GraniteSession> => session);
  const preprocess = vi.fn(
    async (image: Uint8Array): Promise<Record<string, unknown>> => ({
      pixel_values: image,
    }),
  );
  const postResult = overrides.postResult ?? { text: "Hello", confidence: 0.9 };
  const postprocess = vi.fn(
    async (): Promise<{ text: string; confidence?: number }> => postResult,
  );
  const opts: GraniteDoclingOptions = {
    mode: overrides.mode ?? "browser",
    hasWebGPU: overrides.hasWebGPU,
    sessionFactory: factory,
    preprocess,
    postprocess,
  };
  return { opts, factory, preprocess, postprocess, session };
}

// ─── model descriptor ────────────────────────────────────────────────────────

describe("GRANITE_MODEL descriptor", () => {
  it("is the documented placeholder for the 258M ONNX model", () => {
    expect(GRANITE_MODEL.id).toBe("granite-docling-258m");
    expect(GRANITE_MODEL.version).toBe("1");
    expect(GRANITE_MODEL.precision).toBe("int4");
    expect(GRANITE_MODEL.url).toContain("granite-docling-258M");
    expect(GRANITE_MODEL.sizeHintBytes).toBeGreaterThan(0);
  });
});

// ─── conformance ─────────────────────────────────────────────────────────────

describe("createGraniteDoclingEngine conformance", () => {
  it("is named granite-docling", () => {
    const engine = createGraniteDoclingEngine({ mode: "edge" });
    expect(engine.name).toBe("granite-docling");
  });

  // Without an injected sessionFactory, recognize() always throws (the TODO stub),
  // so `available` must be false — claiming true would only waste page rendering
  // before the cascade falls through. (P4 / R4-K: honest availability.)
  const realFactory = vi.fn(async (): Promise<GraniteSession> => makeFakeSession());

  it("is unavailable in any mode when no sessionFactory is injected", () => {
    expect(createGraniteDoclingEngine({ mode: "edge" }).available).toBe(false);
    expect(createGraniteDoclingEngine({ mode: "browser", hasWebGPU: true }).available).toBe(false);
  });

  it("is available in edge mode when a factory is wired, regardless of WebGPU", () => {
    expect(
      createGraniteDoclingEngine({ mode: "edge", sessionFactory: realFactory }).available,
    ).toBe(true);
  });

  it("is available in browser mode (with a factory) only when hasWebGPU is true", () => {
    expect(
      createGraniteDoclingEngine({
        mode: "browser",
        hasWebGPU: true,
        sessionFactory: realFactory,
      }).available,
    ).toBe(true);
    expect(
      createGraniteDoclingEngine({
        mode: "browser",
        hasWebGPU: false,
        sessionFactory: realFactory,
      }).available,
    ).toBe(false);
    // defaults hasWebGPU to false
    expect(
      createGraniteDoclingEngine({ mode: "browser", sessionFactory: realFactory }).available,
    ).toBe(false);
  });
});

// ─── lazy init + warm singleton ──────────────────────────────────────────────

describe("lazy session lifecycle", () => {
  it("creates the session on first recognize() and reuses it on the second (warm singleton)", async () => {
    const { opts, factory, session } = makeMocked({ mode: "edge" });
    const engine = createGraniteDoclingEngine(opts);

    await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    await engine.recognize(NON_EMPTY_IMAGE, baseCtx());

    // sessionFactory invoked exactly once across both calls.
    expect(factory).toHaveBeenCalledTimes(1);
    // but session.run fires once per recognize().
    expect(session.runCount).toBe(2);
  });

  it("does not create the session when the image is empty", async () => {
    const { opts, factory } = makeMocked({ mode: "edge" });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "" });
    expect(factory).not.toHaveBeenCalled();
  });
});

// ─── recognition outcomes ────────────────────────────────────────────────────

describe("recognize outcomes", () => {
  it("returns the postprocessed text and confidence on the happy path", async () => {
    const { opts } = makeMocked({ mode: "edge" });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "Hello", confidence: 0.9 });
  });

  it("trims surrounding whitespace from postprocessed text", async () => {
    const { opts } = makeMocked({
      mode: "edge",
      postResult: { text: "  wrapped  ", confidence: 0.8 },
    });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result.text).toBe("wrapped");
  });

  it("falls through to empty text when confidence is below 0.2", async () => {
    const { opts } = makeMocked({
      mode: "edge",
      postResult: { text: "x", confidence: 0.1 },
    });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "" });
  });

  it("falls through to empty text when postprocessed text is empty", async () => {
    const { opts } = makeMocked({
      mode: "edge",
      postResult: { text: "", confidence: 0.95 },
    });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "" });
  });

  it("keeps text when confidence is undefined (no confidence gate)", async () => {
    const { opts } = makeMocked({
      mode: "edge",
      postResult: { text: "no-conf" },
    });
    const engine = createGraniteDoclingEngine(opts);

    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "no-conf" });
    expect(result.confidence).toBeUndefined();
  });
});

// ─── abort ───────────────────────────────────────────────────────────────────

describe("abort handling", () => {
  it("throws 'aborted' when the signal is already aborted (before session creation)", async () => {
    const { opts, factory } = makeMocked({ mode: "edge" });
    const engine = createGraniteDoclingEngine(opts);

    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.recognize(NON_EMPTY_IMAGE, baseCtx({ signal: controller.signal })),
    ).rejects.toThrow("aborted");
    // the abort check precedes session creation, so the factory is never called.
    expect(factory).not.toHaveBeenCalled();
  });

  it("produces a recognisable AbortError (name === 'AbortError'), not a plain Error", async () => {
    const { opts } = makeMocked({ mode: "edge" });
    const engine = createGraniteDoclingEngine(opts);
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await engine.recognize(NON_EMPTY_IMAGE, baseCtx({ signal: controller.signal }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });
});

// ─── resilience (P4: poisoned-singleton reset + size guard) ──────────────────

describe("resilience", () => {
  it("recovers after a transient session-creation failure (clears the poisoned singleton)", async () => {
    let calls = 0;
    const factory = vi.fn(async (): Promise<GraniteSession> => {
      calls += 1;
      if (calls === 1) throw new Error("transient ONNX init blip");
      return makeFakeSession();
    });
    const engine = createGraniteDoclingEngine({
      mode: "edge",
      sessionFactory: factory,
      preprocess: vi.fn(async (image: Uint8Array) => ({ pixel_values: image })),
      postprocess: vi.fn(async () => ({ text: "recovered", confidence: 0.9 })),
    });

    // First recognize: factory rejects ⇒ the engine must NOT cache that rejection.
    await expect(engine.recognize(NON_EMPTY_IMAGE, baseCtx())).rejects.toThrow("transient");
    // Second recognize: factory is retried (not reused) and succeeds.
    const result = await engine.recognize(NON_EMPTY_IMAGE, baseCtx());
    expect(result).toEqual({ text: "recovered", confidence: 0.9 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("throws (does not OOM) when the image exceeds maxImageBytes", async () => {
    const factory = vi.fn(async (): Promise<GraniteSession> => makeFakeSession());
    const engine = createGraniteDoclingEngine({
      mode: "edge",
      sessionFactory: factory,
      maxImageBytes: 10,
    });
    const oversize = new Uint8Array(11);

    await expect(engine.recognize(oversize, baseCtx())).rejects.toThrow(/too large/);
    // the size guard precedes session creation, so the factory is never called.
    expect(factory).not.toHaveBeenCalled();
  });
});
