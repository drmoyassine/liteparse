import { noneOcr } from "./ocr/none.js";
import { noneRaster } from "./raster/none.js";
import type { OcrEngine, ParseOptions, RasterAdapter } from "./types.js";

/**
 * Adapter resolution. Platform-specific adapters are reached only through lazy
 * dynamic imports guarded by runtime detection, so this module — and therefore the
 * whole core bundle — never pulls in sharp / onnxruntime-web / pdfjs-dist at import
 * time.
 *
 * Build steps extend the resolution matrix:
 *   - Step 2: canvas raster (browser) + VLM OCR engine
 *   - Step 3: sharp raster (node)
 *   - Step 4: RapidOCR OCR engine (browser, WASM)
 *
 * Until then both fall back to the `none` adapters, which means OCR/VLM only work
 * when the caller *injects* adapters (or, for VLM, supplies a gateway — handled
 * directly by the pipeline fallback, not via an engine).
 */

function isBrowser(): boolean {
  return (
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

function isNode(): boolean {
  return (
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process !== "undefined" &&
    !!((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node)
  );
}

/** Resolve a raster adapter: explicit injection wins, else runtime auto-detection, else `none`. */
export async function resolveRaster(opts: ParseOptions): Promise<RasterAdapter> {
  if (opts.raster) return opts.raster;

  if (isBrowser()) {
    // Step 2: dynamic import("./raster/canvas.js").
    return noneRaster;
  }
  if (isNode()) {
    // Step 3: try dynamic import("./raster/sharp.js"), fall back to none on failure.
    return noneRaster;
  }
  return noneRaster;
}

/** Resolve an OCR engine: explicit injection wins; "off" or nothing → `none`. */
export async function resolveOcr(opts: ParseOptions): Promise<OcrEngine> {
  if (opts.ocrEngine) return opts.ocrEngine;
  if (opts.ocr === "off") return noneOcr;

  if (isBrowser()) {
    // Step 4: prefer RapidOCR when available; step 2 also offers a VLM engine.
    return noneOcr;
  }
  // Node / Deno: no local OCR engine shipped; rely on the injected VLM gateway.
  return noneOcr;
}

export const runtimeInfo = { isBrowser, isNode };
