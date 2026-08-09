/**
 * Phase 0 contract smoke tests.
 *
 * These are the executable spec for the router + worker contracts. Constructing
 * a valid value of each type is itself a compile-time check: if a downstream
 * phase changes a type, these factories stop compiling. Phase 1+ agents should
 * treat the factories here as the canonical "how to build a DocumentProfile /
 * RuntimeCapabilities / RouteDecision / protocol message" reference.
 */
import { describe, expect, it } from "vitest";
import { isProgress, isResult, isError } from "../src/worker/protocol.js";
import type {
  DocumentProfile,
  RuntimeCapabilities,
  RouteDecision,
} from "../src/router/types.js";
import type {
  JobId,
  ParseRequest,
  WorkerInbound,
  WorkerOutbound,
} from "../src/worker/protocol.js";
import type { ParsedDocument } from "../src/types.js";

// ─── factories (canonical construction examples) ─────────────────────────────

function scannedPdfProfile(overrides: Partial<DocumentProfile> = {}): DocumentProfile {
  return {
    kind: "pdf",
    pages: 15,
    scanned: true,
    script: "cjk",
    languageHint: "ja",
    bytes: 2_400_000,
    notes: ["textLayer probe: <10 chars on page 1"],
    ...overrides,
  };
}

function imageProfile(overrides: Partial<DocumentProfile> = {}): DocumentProfile {
  return { kind: "image", pages: 1, scanned: null, script: "unknown", bytes: 800_000, ...overrides };
}

function browserCaps(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    runtime: "browser",
    hasWebGPU: true,
    metered: false,
    availableScripts: ["latin", "arabic"],
    storagePersisted: true,
    ...overrides,
  };
}

function ocrDocument(text = "extracted text"): ParsedDocument {
  return {
    text,
    source: "ocr",
    pages: [{ index: 0, text, source: "ocr" }],
    warnings: [],
    kind: "pdf",
    meta: {
      pagesProcessed: 1,
      totalPages: 1,
      nativePages: 0,
      ocrPages: 1,
      vlmPages: 0,
      truncated: false,
      chars: text.length,
    },
  };
}

// ─── DocumentProfile ─────────────────────────────────────────────────────────

describe("DocumentProfile contract", () => {
  it("represents a scanned multi-page PDF", () => {
    const p = scannedPdfProfile();
    expect(p.scanned).toBe(true);
    expect(p.pages).toBe(15);
    expect(p.script).toBe("cjk");
  });

  it("represents an image: pages=1, scanned=null (concept doesn't apply)", () => {
    const p = imageProfile();
    expect(p.scanned).toBeNull();
    expect(p.pages).toBe(1);
  });

  it("represents office/text: scanned=null", () => {
    const p: DocumentProfile = {
      kind: "xlsx",
      pages: 1,
      scanned: null,
      script: "latin",
      bytes: 50_000,
    };
    expect(p.kind).toBe("xlsx");
    expect(p.scanned).toBeNull();
  });
});

// ─── RuntimeCapabilities ─────────────────────────────────────────────────────

describe("RuntimeCapabilities contract", () => {
  it("a WebGPU browser reports latin + one dynamic script", () => {
    const caps = browserCaps();
    expect(caps.hasWebGPU).toBe(true);
    // The membership check routeDocument will perform:
    expect(caps.availableScripts.includes("arabic")).toBe(true);
    expect(caps.availableScripts.includes("cjk")).toBe(false);
  });

  it("a no-GPU node runtime has only latin and no WebGPU", () => {
    const caps = browserCaps({
      runtime: "node",
      hasWebGPU: false,
      availableScripts: ["latin"],
      storagePersisted: false,
    });
    expect(caps.hasWebGPU).toBe(false);
    expect(caps.availableScripts).toEqual(["latin"]);
  });

  it("flags a metered connection (large downloads should defer)", () => {
    const caps = browserCaps({ metered: true });
    expect(caps.metered).toBe(true);
  });
});

// ─── RouteDecision ───────────────────────────────────────────────────────────

describe("RouteDecision contract", () => {
  it("orders a big scanned PDF to edge with targeted fallbacks", () => {
    const decision: RouteDecision = {
      reason: "scanned PDF, 15 pages, cjk → edge rapidocr → granite → vlm",
      strategies: [
        { engine: "rapidocr", location: "edge", script: "cjk", reason: ">browser page cap" },
        { engine: "granite-docling", location: "edge", reason: "low-confidence fallback" },
        { engine: "vlm", location: "edge", reason: "last resort" },
      ],
    };
    expect(decision.strategies).toHaveLength(3);
    expect(decision.strategies[0]?.engine).toBe("rapidocr");
    expect(decision.strategies[0]?.location).toBe("edge");
    // fallbacks are ordered, not brute-forced — the last is the true last resort
    expect(decision.strategies[2]?.engine).toBe("vlm");
  });

  it("routes a plain text screenshot to browser rapidocr only", () => {
    const decision: RouteDecision = {
      reason: "image, latin → browser rapidocr",
      strategies: [
        { engine: "rapidocr", location: "browser", script: "latin", reason: "image" },
      ],
    };
    expect(decision.strategies).toHaveLength(1);
    expect(decision.strategies[0]?.location).toBe("browser");
  });
});

// ─── Worker protocol ─────────────────────────────────────────────────────────

describe("worker protocol contract", () => {
  const id: JobId = "job-1";

  it("round-trips parse request → progress → result", () => {
    const req: ParseRequest = {
      type: "parse",
      id,
      bytes: new ArrayBuffer(8),
      filename: "scan.pdf",
      profile: scannedPdfProfile(),
      route: {
        reason: "edge",
        strategies: [{ engine: "rapidocr", location: "edge", script: "cjk", reason: "primary" }],
      },
    };
    const inbound: WorkerInbound = req;
    expect(inbound.type).toBe("parse");

    const progress: WorkerOutbound = {
      type: "progress",
      id,
      pageIndex: 0,
      totalPages: 15,
      stage: "rapidocr",
      engine: "rapidocr",
    };
    expect(isProgress(progress)).toBe(true);
    expect(isResult(progress)).toBe(false);

    const result: WorkerOutbound = {
      type: "result",
      id,
      document: ocrDocument(),
      engine: "rapidocr",
    };
    expect(isResult(result)).toBe(true);
    expect(result.document.source).toBe("ocr");
  });

  it("cancel is a valid inbound message", () => {
    const cancel: WorkerInbound = { type: "cancel", id };
    expect(cancel.type).toBe("cancel");
  });

  it("error events carry a message + stage", () => {
    const err: WorkerOutbound = {
      type: "error",
      id,
      message: "all strategies exhausted",
      stage: "vlm",
    };
    expect(isError(err)).toBe(true);
    expect(isProgress(err)).toBe(false);
    expect(isResult(err)).toBe(false);
  });
});
