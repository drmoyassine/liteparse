import {
  parseDocument,
  type OcrEngine,
  type ParseOptions,
  type ParsedDocument,
  type PdfLibrary,
  type RasterAdapter,
} from "@drmoyassine/liteparse";
import { createRapidOcrServerEngine } from "@drmoyassine/liteparse/ocr/rapidocr-server";
import { createSharpRaster } from "@drmoyassine/liteparse/raster/sharp";
import { createServerVlmGateway } from "@drmoyassine/liteparse/vlm/server";
import type { RequestedParseOptions } from "./types.js";

/**
 * The parse service behind POST /parse: liteparse's parseDocument wired with
 * the browser-parity adapters — sharp raster, the onnxruntime-node RapidOCR
 * engine (singleton, warmed at boot), and an optional per-request VLM gateway
 * (the caller resolves its own VLM credentials; nothing persists here).
 */
export type ParseService = (
  bytes: Uint8Array,
  filename: string | undefined,
  options: RequestedParseOptions | undefined,
  signal: AbortSignal,
) => Promise<ParsedDocument>;

/** Library default is 30s/page; the runner's callers (edge + agent tool) use 60s — keep parity. */
export const DEFAULT_PER_PAGE_TIMEOUT_MS = 60_000;

export function createLiteparseService(opts: { debug?: boolean } = {}): ParseService {
  // Lazy singletons: the natives are heavy (model load, libvips). Warmed at boot by index.ts.
  let rasterP: Promise<RasterAdapter> | null = null;
  let ocrP: Promise<OcrEngine> | null = null;
  let pdfjsP: Promise<PdfLibrary> | null = null;

  return async (bytes, filename, options, signal) => {
    rasterP ??= createSharpRaster();
    // The engine itself is a process-wide singleton; racing calls share the same load.
    ocrP ??= createRapidOcrServerEngine({ debug: opts.debug });
    pdfjsP ??= loadPdfLibrary();
    const [raster, ocrEngine, pdfjs] = await Promise.all([rasterP, ocrP, pdfjsP]);

    return parseDocument(bytes, toParseOptions(filename, options, signal, { raster, ocrEngine, pdfjs }));
  };
}

/**
 * Build the pdfjs instance the page-image route requires (renderPageImages throws
 * "pdf OCR requires a pdfjs instance" without one — the library never self-supplies
 * it there, by design: the composition root owns setup, like the browser worker
 * shell). Mirrors pdf.ts's non-browser branch (kept in sync): DOMMatrix polyfill,
 * then the legacy build, which runs its fake worker in-process on Node.
 */
async function loadPdfLibrary(): Promise<PdfLibrary> {
  const g = globalThis as { DOMMatrix?: unknown };
  if (typeof g.DOMMatrix === "undefined") {
    try {
      const m = (await import("dommatrix")) as {
        DOMMatrix?: unknown;
        default?: { DOMMatrix?: unknown } | unknown;
      };
      const Ctor = (m.DOMMatrix ??
        (m.default as { DOMMatrix?: unknown } | undefined)?.DOMMatrix ??
        m.default ??
        m) as unknown;
      if (typeof Ctor === "function") g.DOMMatrix = Ctor as new () => unknown;
    } catch {
      // The legacy build guards DOM APIs itself; proceed without the polyfill.
    }
  }
  const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument?: unknown;
    default?: unknown;
  };
  return ((mod.getDocument ? mod : mod.default) ?? mod) as PdfLibrary;
}

/**
 * Map the HTTP request's options onto liteparse's ParseOptions, clamping caller
 * values to sane bounds (a hostile/buggy caller must not pin unbounded budgets).
 * The raster + OCR + pdfjs adapters are ALWAYS injected — without them the
 * page-image route finds neither renderer nor engine on Node, which is exactly
 * the `raster unavailable` limitation (DEC-082) this runner exists to fix.
 * Pure — unit-tested.
 */
export function toParseOptions(
  filename: string | undefined,
  options: RequestedParseOptions | undefined,
  signal: AbortSignal,
  adapters: { raster: RasterAdapter; ocrEngine: OcrEngine; pdfjs: PdfLibrary },
): ParseOptions {
  const opts: ParseOptions = {
    filename,
    signal,
    raster: adapters.raster,
    ocrEngine: adapters.ocrEngine,
    pdfjs: adapters.pdfjs,
    maxPages: clamp(options?.maxPages, 1, 50),
    perPageTimeoutMs: clamp(options?.perPageTimeoutMs, 1_000, 120_000) ?? DEFAULT_PER_PAGE_TIMEOUT_MS,
    maxChars: clamp(options?.maxChars, 100, 200_000),
  };
  if (options?.vlm) {
    opts.vlm = createServerVlmGateway({
      ...options.vlm,
      // Deterministic transcription — default 0; a caller override stays authoritative.
      temperature: options.vlm.temperature ?? 0,
    });
  }
  return opts;
}

function clamp(v: number | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}
