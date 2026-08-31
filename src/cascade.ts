import { parseDocument } from "./pipeline.js";
import { sniff } from "./sniff.js";
import type {
  DocKind,
  OcrEngine,
  ParsedDocument,
  PdfLibrary,
  RasterAdapter,
  VlmGateway,
  WholeDocOcrProvider,
} from "./types.js";

/**
 * Size-aware, cost-first OCR cascade. This is the high-level entry point for callers
 * that want the cheapest engine to handle the common case and heavier engines only to
 * kick in for big / hard documents, with a VLM safety net.
 *
 * Design goals (see plan: "Engine swappability is a hard requirement"):
 *   - The cascade never names an engine. Slots, the page-image engine, the raster, and
 *     the VLM are all *injected*. Swapping RapidOCR for a lighter engine is a single
 *     reference change; reordering/omitting a whole-doc leg is config, not code.
 *   - Whole-document providers (e.g. a hosted OCR API) run first — they read an image
 *     *or* a whole scanned PDF in one cheap call, no local rasterisation, no cold start.
 *   - If no whole-doc slot yields adequate text (or none are gated in), fall back to
 *     {@link parseDocument} — now itself router-driven (classify → route → execute) —
 *     with the injected page-image OCR engine + raster.
 *
 * Example (server):
 *
 *   const result = await parseWithFallbacks(bytes, {
 *     filename,
 *     url,                                   // pass a public URL to a hosted OCR provider if you have one
 *     slots: [
 *       { provider: hostedOcrProvider, when: (i) => i.bytes.byteLength <= 1_000_000 && (i.kind === "image" || i.kind === "pdf") },
 *     ],
 *     ocrEngine: rapidOcrEngine,             // current; swappable for a lighter engine
 *     raster: sharpRaster,
 *     vlm: vlmGateway,                       // final fallback
 *   });
 *   // result.engine → "hosted-ocr" | rapidOcrEngine.name | "vlm" | "native" | "none"
 */

export interface CascadeInput {
  bytes: Uint8Array;
  filename?: string;
  /** Public URL of the document, forwarded to whole-doc providers. */
  url?: string;
  /** Sniffed kind (image/pdf/docx/…), so `when` predicates can gate by type. */
  kind: DocKind;
}

/** A whole-document OCR slot in the cascade (per-image engines go in `ocrEngine`). */
export interface OcrSlot {
  kind?: "whole-doc"; // discriminator for future slot kinds; whole-doc is the default
  provider: WholeDocOcrProvider;
  /**
   * Gate controlling when this slot runs. Defaults to always. Use it to e.g. restrict
   * a hosted OCR provider to small images/PDFs (within its free-tier size cap).
   */
  when?: (input: CascadeInput) => boolean;
}

export interface ParseWithFallbacksOptions {
  filename?: string;
  /** Public URL of the document (passed to whole-doc providers that accept it). */
  url?: string;
  /** Ordered whole-doc OCR slots tried before the per-page parseDocument path. */
  slots?: OcrSlot[];
  /** Page-image OCR engine for the heavy parseDocument path (swappable). */
  ocrEngine?: OcrEngine;
  /** Raster adapter for the heavy path (needed to OCR scanned-PDF pages). */
  raster?: RasterAdapter;
  /** VLM gateway — final fallback inside parseDocument. */
  vlm?: VlmGateway;
  /**
   * Min non-whitespace chars for a whole-doc slot result to count as adequate and
   * short-circuit the cascade. Below this → fall through. Default 3.
   */
  adequateChars?: number;
  /** Forwarded to {@link parseDocument}. */
  maxPages?: number;
  maxChars?: number;
  perPageTimeoutMs?: number;
  pdfjs?: PdfLibrary;
  signal?: AbortSignal;
}

/** {@link ParsedDocument} + the name of the engine/slot that produced the text. */
export interface CascadedResult extends ParsedDocument {
  /**
   * Producing engine/slot: a whole-doc provider's `name` (e.g. "ocr-space"), the
   * page-image engine's `name` (e.g. "rapidocr"), or "vlm" / "native" / "mixed" /
   * "none". `undefined` only when undeterminable.
   */
  engine?: string;
}

function synthesizeFromWholeDoc(text: string, providerName: string, kind: DocKind): CascadedResult {
  const trimmed = (text ?? "").trim();
  const pages = trimmed.length ? [{ index: 0, text: trimmed, source: "ocr" as const }] : [];
  return {
    text: trimmed,
    source: trimmed.length ? "ocr" : "none",
    pages,
    warnings: [],
    kind,
    meta: {
      pagesProcessed: pages.length,
      totalPages: 1,
      nativePages: 0,
      ocrPages: pages.length,
      vlmPages: 0,
      sttPages: 0,
      truncated: false,
      chars: trimmed.length,
    },
    engine: providerName,
  };
}

function mapSourceToEngine(
  source: ParsedDocument["source"],
  ocrEngine?: OcrEngine,
): string | undefined {
  switch (source) {
    case "ocr":
      return ocrEngine?.name ?? "ocr";
    case "vlm":
      return "vlm";
    case "native":
      return "native";
    default:
      return source; // "mixed" | "none"
  }
}

export async function parseWithFallbacks(
  bytes: Uint8Array,
  options: ParseWithFallbacksOptions = {},
): Promise<CascadedResult> {
  if (options.signal?.aborted) throw new Error("aborted");

  const adequateChars = options.adequateChars ?? 3;
  const { kind } = sniff({ bytes, filename: options.filename });
  const input: CascadeInput = { bytes, filename: options.filename, url: options.url, kind };

  // 1) Whole-doc slots in order, each gated by its optional `when` predicate.
  for (const slot of options.slots ?? []) {
    if (slot.when && !slot.when(input)) continue;
    try {
      const out = await slot.provider.parseDoc({
        bytes,
        url: options.url,
        filename: options.filename,
        signal: options.signal,
      });
      if ((out.text ?? "").trim().length >= adequateChars) {
        return synthesizeFromWholeDoc(out.text, slot.provider.name, kind);
      }
      // adequate text not reached → fall through to next slot / heavy path
    } catch (e) {
      if ((e as Error).message === "aborted") throw e;
      // provider error → fall through (do not let a hosted blip kill parsing)
    }
  }

  // 2) Heavy path: parseDocument with the (swappable) page-image OCR engine + raster,
  //    which already cascades OCR → VLM internally.
  const result = await parseDocument(bytes, {
    filename: options.filename,
    raster: options.raster,
    ocrEngine: options.ocrEngine,
    vlm: options.vlm,
    maxPages: options.maxPages,
    maxChars: options.maxChars,
    perPageTimeoutMs: options.perPageTimeoutMs,
    pdfjs: options.pdfjs,
    signal: options.signal,
  });

  return { ...result, engine: mapSourceToEngine(result.source, options.ocrEngine) };
}
