/**
 * Router contracts for the Intelligent Document Router (liteparse 0.3.0+).
 *
 * These types are the **foundation** every downstream module codes against:
 *   - `classifyDocument` (Phase 1) produces a {@link DocumentProfile}.
 *   - `detectCapabilities` (Phase 1) produces {@link RuntimeCapabilities}.
 *   - `routeDocument` (Phase 2) turns (profile, capabilities) → {@link RouteDecision}.
 *   - the worker (Phase 2) executes the {@link RouteDecision}.
 *
 * See ARCHITECTURE.md (design) and ROADMAP.md (build plan).
 *
 * These are deliberately decoupled from any engine implementation: an
 * {@link ExtractionEngine} is just a string tag, so classify/capabilities/route
 * can be unit-tested with no ONNX / pdfjs / sharp loaded.
 */

import type { DocKind } from "../types.js";

/**
 * Writing-system family. Determines which PaddleOCR/RapidOCR recognition model
 * is needed. Detection is language-agnostic (one model); recognition is per
 * script. Latin is the always-loaded browser default and covers en/es/it/fr/de
 * + ~30 others in a single model. See ARCHITECTURE.md → Language Strategy.
 */
export type Script =
  | "latin" // en, es, it, fr, de, … — one recognition model, always in browser
  | "arabic" // Arabic script — separate model, RTL handling
  | "cyrillic" // ru, uk, bg, …
  | "cjk" // zh / ja / ko (may refine to per-language models later)
  | "devanagari" // hi, mr, …
  | "other" // a script we can map to a model but isn't first-class
  | "unknown"; // not yet detected (e.g. raw image before any OCR)

/**
 * Engine that can extract text. Each maps to an existing or planned adapter.
 * Mirrors the adapters liteparse ships; kept as a string union so the router
 * stays free of runtime imports.
 */
export type ExtractionEngine =
  | "pdfjs-text" // native text layer (digital PDFs)
  | "mammoth" // .docx
  | "xlsx" // .xlsx / .csv via sheetjs
  | "text" // readAsText (.txt / .md / .csv)
  | "rapidocr" // PaddleOCR detection + recognition (raw text)
  | "granite-docling" // 258M structure-aware VLM (text + layout/tables/reading-order)
  | "vlm" // hosted vision LLM — true last resort
  | "moonshine" // local Moonshine STT (audio documents; browser WASM / runner)
  | "stt-gateway"; // external STT gateway (audio docs) — quality ceiling / fallback

/** Where a strategy executes. Browser = the Web Worker; edge = the serverless service. */
export type ExecutionLocation = "browser" | "edge";

/** A single ordered step in the execution plan. */
export interface RouteStrategy {
  engine: ExtractionEngine;
  location: ExecutionLocation;
  /** Script this strategy targets (OCR engines only; office/pdfjs-text omit). */
  script?: Script;
  /** Short reason surfaced in warnings/logs (e.g. "scanned PDF, >3 pages, no WebGPU"). */
  reason: string;
}

/**
 * The output of routing. `strategies` is the ordered execution plan: run in
 * sequence, keep the first that yields usable text. `strategies[0]` is the
 * primary (expected) path; the rest are targeted fallbacks, not brute force.
 */
export interface RouteDecision {
  strategies: RouteStrategy[];
  /** Human-readable summary of the decision, for warnings/logs (e.g.
   *  "scanned PDF, 15 pages, cjk → edge rapidocr → edge granite → vlm"). */
  reason: string;
}

/**
 * A document's classification, produced once (at attach time, overlapping user
 * typing, so it's free by send). See ARCHITECTURE.md → Classification Signals.
 */
export interface DocumentProfile {
  /** Coarse content category — reuses sniff's {@link DocKind}. */
  kind: DocKind;
  /** Page count. 1 for non-paginated inputs (images/office/text); 0 if undeterminable. */
  pages: number;
  /** Scanned vs digital PDF. `null` for non-PDFs (the concept doesn't apply). */
  scanned: boolean | null;
  /** Detected writing system. `unknown` until a signal is found. */
  script: Script;
  /** Best-guess ISO 639-1 language code, if derivable from content or user context. */
  languageHint?: string;
  /** File size in bytes. */
  bytes: number;
  /** Optional classification notes (timing, confidence, probe details) — debug only. */
  notes?: string[];
}

/**
 * What the runtime can actually do. Gates routing: e.g. no WebGPU ⇒ Granite can't
 * run in-browser ⇒ those docs route to edge Granite. Produced by
 * `detectCapabilities` (Phase 1).
 */
export interface RuntimeCapabilities {
  runtime: "browser" | "node" | "deno";
  /** True if a usable WebGPU adapter exists (Granite-Docling can run locally, fast). */
  hasWebGPU: boolean;
  /** True if the connection is metered/slow — defer large model downloads. */
  metered: boolean;
  /** Scripts whose recognition models are already available in this runtime.
   *  Browser always includes `latin`; a dynamic second script may be present. */
  availableScripts: Script[];
  /** Whether persistent storage has been granted (model-cache survival). */
  storagePersisted: boolean;
}

/** Options for `routeDocument` (implemented in Phase 2). Defined here so Phase 1
 *  modules can reference the shape without importing the (unwritten) router. */
export interface RouteOptions {
  /** In-browser scanned-PDF page cap when WebGPU is available. Default 10. */
  browserOcrPagesWebGPU?: number;
  /** In-browser scanned-PDF page cap on WASM only. Default 3. */
  browserOcrPagesWasm?: number;
  /** Digital-PDF browser page cap (native text layer; no GPU needed). Default 10. */
  browserDigitalPdfPages?: number;
  /** Edge service base URL (where `location: "edge"` strategies are served). */
  edgeUrl?: string;
  /** Whether a hosted VLM gateway is configured (enables the `vlm` last resort). */
  vlmEnabled?: boolean;
  /** Whether a local STT engine is wired (enables the `moonshine` audio leg). */
  sttLocalEnabled?: boolean;
  /** Whether an external STT gateway is configured (audio docs). */
  sttGatewayEnabled?: boolean;
}
