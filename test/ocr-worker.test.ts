/**
 * Tests for src/worker/ocr-worker.ts → `executeRoute` (the pure core).
 *
 * Every dep is injected: text extractors, OCR engines, raster adapter, and a fake
 * pdfjs. No ONNX / WebGPU / real worker — the core is exercised in isolation. The
 * worker shell itself is smoke-tested later (Phase 4); here we lock the routing
 * semantics: walk strategies in order, keep the first usable result, degrade with
 * warnings otherwise, and propagate aborts.
 */
import { describe, expect, it } from "vitest";
import {
  executeRoute,
} from "../src/worker/ocr-worker.js";
import type {
  ExecuteRouteDeps,
  ExecuteRouteInput,
  TextExtractor,
} from "../src/worker/ocr-worker.js";
import type {
  DocumentProfile,
  ExecutionLocation,
  ExtractionEngine,
  RouteStrategy,
} from "../src/router/types.js";
import type {
  DocKind,
  OcrEngine,
  PdfDocumentLike,
  PdfLibrary,
  PdfPageLike,
  RasterAdapter,
} from "../src/types.js";

// ─── factories ───────────────────────────────────────────────────────────────

function profile(kind: DocKind = "image", over: Partial<DocumentProfile> = {}): DocumentProfile {
  return { kind, pages: 1, scanned: null, script: "latin", bytes: 4, ...over };
}

function strat(engine: ExtractionEngine, location: ExecutionLocation = "browser"): RouteStrategy {
  return { engine, location, reason: "test" };
}

function makeInput(
  p: DocumentProfile,
  strategies: RouteStrategy[],
  bytes = new Uint8Array([1, 2, 3, 4]),
): ExecuteRouteInput {
  return { bytes, profile: p, route: { strategies, reason: "test" } };
}

function fakeExtractor(text: string, opts: { throws?: boolean } = {}): TextExtractor {
  return async () => {
    if (opts.throws) throw new Error("extractor boom");
    return text;
  };
}

function fakeEngine(
  name: string,
  text: string,
  opts: { available?: boolean; throws?: boolean } = {},
): OcrEngine {
  return {
    name,
    available: opts.available ?? true,
    recognize: async () => {
      if (opts.throws) throw new Error(`${name} boom`);
      return { text };
    },
  };
}

function fakeRaster(): RasterAdapter & { calls: number } {
  let calls = 0;
  return {
    name: "fake-raster",
    available: true,
    runtime: "node",
    get calls() {
      return calls;
    },
    rasterizePdfPage: async (_doc, idx) => {
      calls++;
      return new Uint8Array([10 + idx]);
    },
  };
}

function fakePdfjs(nPages: number): PdfLibrary {
  const doc: PdfDocumentLike = {
    numPages: nPages,
    getPage: () => Promise.resolve({} as PdfPageLike),
  };
  return { getDocument: () => ({ promise: Promise.resolve(doc) }) };
}

function abortedSignal(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

// ─── text extractor strategies ───────────────────────────────────────────────

describe("executeRoute — text extractors", () => {
  it("returns the first text extractor that yields usable text (native source)", async () => {
    const res = await executeRoute(
      makeInput(profile("docx"), [strat("mammoth")]),
      { extractors: { mammoth: fakeExtractor("hello world") } },
    );
    expect(res.engine).toBe("mammoth");
    expect(res.document.source).toBe("native");
    expect(res.document.text).toBe("hello world");
    expect(res.document.pages).toEqual([
      { index: 0, text: "hello world", source: "native" },
    ]);
    expect(res.document.meta.nativePages).toBe(1);
  });

  it("emits a single 'finalizing' progress event for a text extractor win", async () => {
    const stages: string[] = [];
    await executeRoute(makeInput(profile("text"), [strat("text")]), {
      extractors: { text: fakeExtractor("plain text body") },
      onProgress: (e) => stages.push(e.stage),
    });
    expect(stages).toEqual(["finalizing"]);
  });

  it("falls through when a text extractor under-yields the floor", async () => {
    const res = await executeRoute(makeInput(profile("docx"), [strat("mammoth")]), {
      extractors: { mammoth: fakeExtractor("ab") }, // 2 non-ws chars < default floor 3
    });
    expect(res.engine).toBeUndefined();
    expect(res.document.text).toBe("");
    expect(res.document.source).toBe("none");
    expect(res.document.warnings.some((w) => w.includes("only 2 non-ws"))).toBe(true);
  });

  it("skips a text strategy whose extractor is not wired", async () => {
    const res = await executeRoute(makeInput(profile("docx"), [strat("mammoth")]), {});
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("no extractor wired"))).toBe(true);
  });

  it("records a warning (and falls through) when an extractor throws", async () => {
    const res = await executeRoute(makeInput(profile("xlsx"), [strat("xlsx")]), {
      extractors: { xlsx: fakeExtractor("", { throws: true }) },
    });
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("extractor failed"))).toBe(true);
  });

  it("respects a custom usableFloor", async () => {
    const res = await executeRoute(makeInput(profile("text"), [strat("text")]), {
      extractors: { text: fakeExtractor("abcd") }, // 4 chars
      usableFloor: 5,
    });
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("only 4 non-ws"))).toBe(true);
  });
});

// ─── OCR / vision engine strategies ──────────────────────────────────────────

describe("executeRoute — OCR engines", () => {
  it("recognises a single-page image and returns OCR source", async () => {
    const res = await executeRoute(makeInput(profile("image"), [strat("rapidocr")]), {
      engines: { rapidocr: fakeEngine("rapidocr", "scanned line one") },
    });
    expect(res.engine).toBe("rapidocr");
    expect(res.document.source).toBe("ocr");
    expect(res.document.text).toBe("scanned line one");
    expect(res.document.meta.ocrPages).toBe(1);
  });

  it("renders N PDF pages via the raster, then recognises each (progress order)", async () => {
    const raster = fakeRaster();
    const stages: string[] = [];
    const res = await executeRoute(
      makeInput(profile("pdf", { pages: 2, scanned: true }), [strat("rapidocr")]),
      {
        pdfjs: fakePdfjs(2),
        raster,
        engines: { rapidocr: fakeEngine("rapidocr", "page body") },
        onProgress: (e) => stages.push(`${e.stage}:${e.pageIndex}/${e.totalPages}`),
      },
    );
    expect(raster.calls).toBe(2);
    expect(res.engine).toBe("rapidocr");
    expect(stages).toEqual([
      "rendering:0/2",
      "rendering:1/2",
      "rapidocr:0/2",
      "rapidocr:1/2",
    ]);
    expect(res.document.pages).toHaveLength(2);
  });

  it("skips an unavailable OCR engine with a warning", async () => {
    const res = await executeRoute(makeInput(profile("image"), [strat("rapidocr")]), {
      engines: { rapidocr: fakeEngine("rapidocr", "x", { available: false }) },
    });
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("unavailable"))).toBe(true);
  });

  it("skips an OCR engine that is not wired", async () => {
    const res = await executeRoute(makeInput(profile("image"), [strat("rapidocr")]), {});
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("engine not wired"))).toBe(true);
  });

  it("marks the result as vlm source when the vlm engine wins", async () => {
    const res = await executeRoute(makeInput(profile("image"), [strat("vlm", "edge")]), {
      engines: { vlm: fakeEngine("vlm", "vlm transcription") },
    });
    expect(res.engine).toBe("vlm");
    expect(res.document.source).toBe("vlm");
    expect(res.document.meta.vlmPages).toBe(1);
  });

  it("records a render failure (missing raster) and falls through", async () => {
    const res = await executeRoute(
      makeInput(profile("pdf", { pages: 2, scanned: true }), [strat("rapidocr")]),
      { pdfjs: fakePdfjs(2), engines: { rapidocr: fakeEngine("rapidocr", "x") } },
    );
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("render failed"))).toBe(true);
  });

  it("keeps going when an OCR page throws, recording a per-page warning", async () => {
    const res = await executeRoute(
      makeInput(profile("pdf", { pages: 2, scanned: true }), [
        strat("rapidocr"),
        strat("granite-docling"),
      ]),
      {
        pdfjs: fakePdfjs(2),
        raster: fakeRaster(),
        engines: {
          rapidocr: fakeEngine("rapidocr", "", { throws: true }), // every page throws
          "granite-docling": fakeEngine("granite-docling", "recovered text"),
        },
      },
    );
    // rapidocr failed every page → fell to granite, which recovered.
    expect(res.engine).toBe("granite-docling");
    expect(res.document.source).toBe("ocr");
    expect(res.document.warnings.some((w) => w.includes("page 0 failed"))).toBe(true);
  });
});

// ─── cascade ordering & exhaustion ───────────────────────────────────────────

describe("executeRoute — cascade", () => {
  it("descends rapidocr → granite-docling when the primary under-yields", async () => {
    const res = await executeRoute(
      makeInput(profile("image"), [strat("rapidocr"), strat("granite-docling")]),
      {
        engines: {
          rapidocr: fakeEngine("rapidocr", "ab"), // under floor
          "granite-docling": fakeEngine("granite-docling", "structured output"),
        },
      },
    );
    expect(res.engine).toBe("granite-docling");
    expect(res.document.text).toBe("structured output");
    expect(res.document.warnings.some((w) => w.includes("rapidocr") && w.includes("falling through"))).toBe(true);
  });

  it("returns an empty doc (source none, no engine) when every strategy exhausts", async () => {
    const res = await executeRoute(
      makeInput(profile("image"), [strat("rapidocr"), strat("vlm", "edge")]),
      {
        engines: {
          rapidocr: fakeEngine("rapidocr", ""), // 0 chars
          vlm: fakeEngine("vlm", "  "), // 0 non-ws chars
        },
      },
    );
    expect(res.engine).toBeUndefined();
    expect(res.document.source).toBe("none");
    expect(res.document.text).toBe("");
    expect(res.document.warnings.length).toBeGreaterThan(0);
  });

  it("stops at the first usable strategy (does not run later strategies)", async () => {
    let rapidCalls = 0;
    let graniteCalls = 0;
    await executeRoute(makeInput(profile("image"), [strat("rapidocr"), strat("granite-docling")]), {
      engines: {
        rapidocr: {
          name: "rapidocr",
          available: true,
          recognize: async () => {
            rapidCalls++;
            return { text: "primary hit" };
          },
        },
        "granite-docling": {
          name: "granite-docling",
          available: true,
          recognize: async () => {
            graniteCalls++;
            return { text: "should not run" };
          },
        },
      },
    });
    expect(rapidCalls).toBe(1);
    expect(graniteCalls).toBe(0);
  });
});

// ─── abort ────────────────────────────────────────────────────────────────────

describe("executeRoute — abort", () => {
  it("throws 'aborted' when the signal is already aborted before it starts", async () => {
    await expect(
      executeRoute(
        { ...makeInput(profile("image"), [strat("rapidocr")]), signal: abortedSignal() },
        { engines: { rapidocr: fakeEngine("rapidocr", "x") } },
      ),
    ).rejects.toThrow("aborted");
  });

  it("throws an AbortError (name 'AbortError'), recognizable across layers", async () => {
    let caught: unknown;
    try {
      await executeRoute(
        { ...makeInput(profile("image"), [strat("rapidocr")]), signal: abortedSignal() },
        { engines: { rapidocr: fakeEngine("rapidocr", "x") } },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });
});

// ─── page budget & per-page timeouts (P4 / R2-A) ────────────────────────────

describe("executeRoute — page budget & per-page timeout", () => {
  it("caps rendered pages at maxPages and emits a page_budget warning", async () => {
    const raster = fakeRaster();
    const res = await executeRoute(
      {
        ...makeInput(profile("pdf", { pages: 5, scanned: true }), [strat("rapidocr")]),
        maxPages: 2,
      },
      {
        pdfjs: fakePdfjs(5),
        raster,
        engines: { rapidocr: fakeEngine("rapidocr", "page text") },
      },
    );
    // Only 2 of the 5 pages were rasterized — the budget bounded the work.
    expect(raster.calls).toBe(2);
    expect(res.document.pages).toHaveLength(2);
    expect(
      res.document.warnings.some((w) => w.includes("page_budget") && w.includes("2 of 5")),
    ).toBe(true);
    expect(res.engine).toBe("rapidocr");
  });

  it("does not cap when maxPages is 0 (uncapped)", async () => {
    const raster = fakeRaster();
    await executeRoute(
      {
        ...makeInput(profile("pdf", { pages: 3, scanned: true }), [strat("rapidocr")]),
        maxPages: 0,
      },
      {
        pdfjs: fakePdfjs(3),
        raster,
        engines: { rapidocr: fakeEngine("rapidocr", "page text") },
      },
    );
    expect(raster.calls).toBe(3);
  });

  it("skips a page whose recognize exceeds perPageTimeoutMs (no hang)", async () => {
    const hanging: OcrEngine = {
      name: "rapidocr",
      available: true,
      // Never settles — a stuck engine that would hang the parse without a timeout.
      recognize: () => new Promise<{ text: string }>(() => {}),
    };
    const res = await executeRoute(
      {
        ...makeInput(profile("image"), [strat("rapidocr")]),
        perPageTimeoutMs: 30,
      },
      { engines: { rapidocr: hanging } },
    );
    // The page timed out → empty + warning, engine fell through. Crucially this
    // resolved at all: a stuck recognize did NOT hang the whole parse.
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("timed out"))).toBe(true);
  });
});

// ─── audio (Track 3 STT engines) ─────────────────────────────────────────────

describe("executeRoute — audio (STT engines)", () => {
  it("runs the clip as a single page through a wired STT engine (source stt)", async () => {
    const res = await executeRoute(
      makeInput(profile("audio"), [strat("moonshine"), strat("stt-gateway")]),
      { engines: { moonshine: fakeEngine("moonshine-fake", "transcribed words") } },
    );
    expect(res.engine).toBe("moonshine");
    expect(res.document.source).toBe("stt");
    expect(res.document.text).toBe("transcribed words");
    expect(res.document.pages).toEqual([
      { index: 0, text: "transcribed words", source: "stt" },
    ]);
    expect(res.document.meta.sttPages).toBe(1);
    expect(res.document.meta.ocrPages).toBe(0);
  });

  it("reports progress under the stt stage", async () => {
    const stages: string[] = [];
    await executeRoute(makeInput(profile("audio"), [strat("moonshine")]), {
      engines: { moonshine: fakeEngine("moonshine-fake", "some words") },
      onProgress: (e) => stages.push(e.stage),
    });
    expect(stages).toEqual(["stt"]);
  });

  it("falls through moonshine → stt-gateway on under-yield (both tagged stt)", async () => {
    const res = await executeRoute(
      makeInput(profile("audio"), [strat("moonshine"), strat("stt-gateway")]),
      {
        engines: {
          moonshine: fakeEngine("moonshine-fake", ""), // under the usable floor
          "stt-gateway": fakeEngine("stt-gateway", "rescued text"),
        },
      },
    );
    expect(res.engine).toBe("stt-gateway");
    expect(res.document.source).toBe("stt");
    expect(res.document.meta.sttPages).toBe(1);
    expect(res.document.warnings.some((w) => w.includes("moonshine-fake"))).toBe(true);
  });

  it("records an honest 'not wired' warning when no STT engine exists", async () => {
    const res = await executeRoute(makeInput(profile("audio"), [strat("stt-gateway")]), {});
    expect(res.engine).toBeUndefined();
    expect(res.document.text).toBe("");
    expect(res.document.source).toBe("none");
    expect(
      res.document.warnings.some((w) => w.includes("stt-gateway") && w.includes("not wired")),
    ).toBe(true);
  });

  it("bounds a stuck STT decode with perPageTimeoutMs (no hang)", async () => {
    const hanging: OcrEngine = {
      name: "moonshine-fake",
      available: true,
      recognize: () => new Promise<{ text: string }>(() => {}),
    };
    const res = await executeRoute(
      { ...makeInput(profile("audio"), [strat("moonshine")]), perPageTimeoutMs: 30 },
      { engines: { moonshine: hanging } },
    );
    expect(res.engine).toBeUndefined();
    expect(res.document.warnings.some((w) => w.includes("timed out"))).toBe(true);
  });
});
