/**
 * Tests for src/router/route.ts — the executable spec of the ARCHITECTURE routing
 * matrix. Pure logic, no mocks: each (kind, pages, scanned, script) × capabilities
 * input yields the expected ordered strategy list.
 */
import { describe, expect, it } from "vitest";
import { routeDocument } from "../src/router/route.js";
import type {
  DocumentProfile,
  ExtractionEngine,
  RouteStrategy,
  RuntimeCapabilities,
} from "../src/router/types.js";

// ─── factories ───────────────────────────────────────────────────────────────

function profile(overrides: Partial<DocumentProfile> = {}): DocumentProfile {
  return {
    kind: "pdf",
    pages: 1,
    scanned: null,
    script: "unknown",
    bytes: 100_000,
    ...overrides,
  };
}

function caps(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    runtime: "browser",
    hasWebGPU: true,
    metered: false,
    availableScripts: ["latin"],
    storagePersisted: false,
    ...overrides,
  };
}

/** Project a strategy list to the compact `[engine@location…]` form for assertions. */
function engines(strategies: RouteStrategy[]): string[] {
  return strategies.map((s) => `${s.engine}@${s.location}`);
}

/** Expect the route's primary (first) strategy to carry the given rec-model script. */
function expectScript(strategies: RouteStrategy[], script: string): void {
  const primary = strategies[0];
  expect(primary).toBeDefined();
  expect(primary?.script).toBe(script);
}

// ─── office / text ────────────────────────────────────────────────────────────

describe("routeDocument — office & text (browser-first)", () => {
  it("routes docx → browser mammoth", () => {
    const d = routeDocument(profile({ kind: "docx" }), caps());
    expect(engines(d.strategies)).toEqual(["mammoth@browser"]);
  });

  it("routes xlsx → browser xlsx (sheetjs)", () => {
    const d = routeDocument(profile({ kind: "xlsx" }), caps());
    expect(engines(d.strategies)).toEqual(["xlsx@browser"]);
  });

  it("routes csv → browser xlsx (sheetjs handles csv)", () => {
    const d = routeDocument(profile({ kind: "csv" }), caps());
    expect(engines(d.strategies)).toEqual(["xlsx@browser"]);
  });

  it("routes text → browser text", () => {
    const d = routeDocument(profile({ kind: "text" }), caps());
    expect(engines(d.strategies)).toEqual(["text@browser"]);
  });

  it("routes office to edge on a node runtime", () => {
    const d = routeDocument(profile({ kind: "docx" }), caps({ runtime: "node" }));
    expect(engines(d.strategies)).toEqual(["mammoth@edge"]);
  });
});

// ─── images ──────────────────────────────────────────────────────────────────

describe("routeDocument — images", () => {
  it("a latin/unknown screenshot on a WebGPU browser → browser rapidocr + browser docling (no vlm by default)", () => {
    const d = routeDocument(profile({ kind: "image", script: "unknown" }), caps({ hasWebGPU: true }));
    expect(engines(d.strategies)).toEqual(["rapidocr@browser", "granite-docling@browser"]);
    // unknown script normalises to the latin recognition model on the primary leg
    expectScript(d.strategies, "latin");
  });

  it("an image whose detected script is cached → browser rapidocr carries that script", () => {
    const d = routeDocument(
      profile({ kind: "image", script: "arabic" }),
      caps({ hasWebGPU: true, availableScripts: ["latin", "arabic"] }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@browser", "granite-docling@browser"]);
    expectScript(d.strategies, "arabic");
  });

  it("an image whose script is NOT cached → edge rapidocr, browser docling (WebGPU present)", () => {
    const d = routeDocument(
      profile({ kind: "image", script: "cjk" }),
      caps({ hasWebGPU: true, availableScripts: ["latin"] }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@edge", "granite-docling@browser"]);
    expectScript(d.strategies, "cjk");
  });

  it("an image on a no-GPU browser → browser rapidocr (WASM), edge docling", () => {
    const d = routeDocument(profile({ kind: "image", script: "latin" }), caps({ hasWebGPU: false }));
    expect(engines(d.strategies)).toEqual(["rapidocr@browser", "granite-docling@edge"]);
  });

  it("appends an edge VLM last resort when vlmEnabled", () => {
    const d = routeDocument(profile({ kind: "image" }), caps(), { vlmEnabled: true });
    expect(engines(d.strategies)).toEqual([
      "rapidocr@browser",
      "granite-docling@browser",
      "vlm@edge",
    ]);
  });
});

// ─── digital PDF ─────────────────────────────────────────────────────────────

describe("routeDocument — digital PDF (scanned=false)", () => {
  it("≤10 pages → browser pdfjs-text", () => {
    const d = routeDocument(profile({ kind: "pdf", pages: 10, scanned: false }), caps());
    expect(engines(d.strategies)).toEqual(["pdfjs-text@browser"]);
  });

  it(">10 pages → edge pdfjs-text", () => {
    const d = routeDocument(profile({ kind: "pdf", pages: 11, scanned: false }), caps());
    expect(engines(d.strategies)).toEqual(["pdfjs-text@edge"]);
  });

  it("uses browserDigitalPdfPages (not the OCR scanned-page cap) to place a digital PDF (P4 / R3-F)", () => {
    // A 7-page digital PDF in the browser. The OCR scanned-page cap is set low (4),
    // but the digital cap is 10. Pre-fix this wrongly routed to edge (digitalCap
    // read browserOcrPagesWebGPU=4); the digital cap must be independent of OCR.
    const d = routeDocument(
      profile({ kind: "pdf", pages: 7, scanned: false }),
      caps({ hasWebGPU: true }),
      { browserOcrPagesWebGPU: 4, browserDigitalPdfPages: 10 },
    );
    expect(engines(d.strategies)).toEqual(["pdfjs-text@browser"]);
  });

  it("crosses to edge only past browserDigitalPdfPages, regardless of the OCR cap (P4 / R3-F)", () => {
    // 11-page digital PDF, digital cap 10 → edge, even with a low OCR cap of 4.
    const d = routeDocument(
      profile({ kind: "pdf", pages: 11, scanned: false }),
      caps({ hasWebGPU: true }),
      { browserOcrPagesWebGPU: 4, browserDigitalPdfPages: 10 },
    );
    expect(engines(d.strategies)).toEqual(["pdfjs-text@edge"]);
  });
});

// ─── scanned PDF ─────────────────────────────────────────────────────────────

describe("routeDocument — scanned PDF", () => {
  it("≤10 pages, WebGPU, script cached → browser rapidocr + browser docling", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 8, scanned: true, script: "latin" }),
      caps({ hasWebGPU: true }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@browser", "granite-docling@browser"]);
  });

  it("≤10 pages, WebGPU, script NOT cached → edge rapidocr + browser docling (docling ignores script)", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 8, scanned: true, script: "cjk" }),
      caps({ hasWebGPU: true, availableScripts: ["latin"] }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@edge", "granite-docling@browser"]);
  });

  it(">10 pages (matrix row: >threshold) → edge rapidocr → edge docling → vlm", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 15, scanned: true, script: "cjk" }),
      caps({ hasWebGPU: true, availableScripts: ["latin", "arabic"] }),
      { vlmEnabled: true },
    );
    expect(engines(d.strategies)).toEqual([
      "rapidocr@edge",
      "granite-docling@edge",
      "vlm@edge",
    ]);
  });

  it("WASM-only browser, ≤3 pages → browser rapidocr, edge docling (no GPU)", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 3, scanned: true, script: "latin" }),
      caps({ hasWebGPU: false }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@browser", "granite-docling@edge"]);
  });

  it("WASM-only browser, >3 pages → edge rapidocr (exceeds WASM cap), edge docling", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 5, scanned: true, script: "latin" }),
      caps({ hasWebGPU: false }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@edge", "granite-docling@edge"]);
  });

  it("honours custom page caps via opts", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 5, scanned: true, script: "latin" }),
      caps({ hasWebGPU: true }),
      { browserOcrPagesWebGPU: 4 },
    );
    // 5 > custom cap 4 → rapidocr and docling both edge
    expect(engines(d.strategies)).toEqual(["rapidocr@edge", "granite-docling@edge"]);
  });
});

// ─── ambiguous / edge cases ──────────────────────────────────────────────────

describe("routeDocument — ambiguous & fallback cases", () => {
  it("scanned=null (ambiguous) tries native text first then the OCR chain", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 5, scanned: null, script: "latin" }),
      caps({ hasWebGPU: true }),
      { vlmEnabled: true },
    );
    expect(engines(d.strategies)).toEqual([
      "pdfjs-text@browser",
      "rapidocr@browser",
      "granite-docling@browser",
      "vlm@edge",
    ]);
  });

  it("pages=0 (pdfjs unavailable locally) defers the whole chain to the edge", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 0, scanned: null, script: "unknown" }),
      caps({ hasWebGPU: true }),
      { vlmEnabled: true },
    );
    expect(engines(d.strategies)).toEqual([
      "rapidocr@edge",
      "granite-docling@edge",
      "vlm@edge",
    ]);
  });

  it("node runtime routes a scanned PDF entirely to the edge", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 4, scanned: true, script: "latin" }),
      caps({ runtime: "node" }),
    );
    expect(engines(d.strategies)).toEqual(["rapidocr@edge", "granite-docling@edge"]);
  });

  it("unknown kind with vlm → edge vlm", () => {
    const d = routeDocument(profile({ kind: "other" }), caps(), { vlmEnabled: true });
    expect(engines(d.strategies)).toEqual(["vlm@edge"]);
  });

  it("unknown kind without vlm → best-effort text", () => {
    const d = routeDocument(profile({ kind: "other" }), caps());
    expect(engines(d.strategies)).toEqual(["text@browser"]);
  });
});

// ─── decision shape ──────────────────────────────────────────────────────────

describe("routeDocument — decision shape", () => {
  it("always returns a non-empty strategies array and a reason string", () => {
    const d = routeDocument(profile({ kind: "image" }), caps());
    expect(d.strategies.length).toBeGreaterThan(0);
    expect(typeof d.reason).toBe("string");
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("the reason summarises kind, pages, script and the chain", () => {
    const d = routeDocument(
      profile({ kind: "pdf", pages: 15, scanned: true, script: "cjk" }),
      caps({ hasWebGPU: true, availableScripts: ["latin"] }),
      { vlmEnabled: true },
    );
    expect(d.reason).toContain("pdf");
    expect(d.reason).toContain("15p");
    expect(d.reason).toContain("cjk");
    expect(d.reason).toContain("rapidocr");
    expect(d.reason).toContain("vlm");
  });

  it("every strategy carries an engine tag and a reason", () => {
    const known: ExtractionEngine[] = [
      "pdfjs-text",
      "mammoth",
      "xlsx",
      "text",
      "rapidocr",
      "granite-docling",
      "vlm",
    ];
    const d = routeDocument(
      profile({ kind: "pdf", pages: 5, scanned: null }),
      caps({ hasWebGPU: true }),
      { vlmEnabled: true },
    );
    for (const s of d.strategies) {
      expect(known).toContain(s.engine);
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });
});
