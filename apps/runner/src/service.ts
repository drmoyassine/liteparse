import {
  createVisionEndpointGateway,
  parseDocument,
  type OcrEngine,
  type OcrResult,
  type Page,
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
  hooks?: { onPage?: (page: Page) => void },
) => Promise<ParsedDocument>;

/** POST /ocr: one page image → the runner's RapidOCR (English or Arabic model). */
export type OcrPageService = (
  png: Uint8Array,
  ctx: { script?: string; pageIndex: number; totalPages: number; signal: AbortSignal },
) => Promise<OcrResult>;

/** Ceilings for caller-supplied budgets (RUNNER_MAX_OCR_PAGES / RUNNER_MAX_CHARS). */
export interface RunnerLimits {
  maxOcrPages: number;
  maxChars: number;
}
export const DEFAULT_RUNNER_LIMITS: RunnerLimits = { maxOcrPages: 300, maxChars: 2_000_000 };

/** Library default is 30s/page; the runner's callers (edge + agent tool) use 60s — keep parity. */
export const DEFAULT_PER_PAGE_TIMEOUT_MS = 60_000;

export function createLiteparseService(
  opts: {
    debug?: boolean;
    limits?: RunnerLimits;
    convertToPdf?: ParseOptions["convertToPdf"];
  } = {},
): ParseService {
  // Lazy singletons: the natives are heavy (model load, libvips). Warmed at boot by index.ts.
  let rasterP: Promise<RasterAdapter> | null = null;
  let ocrP: Promise<OcrEngine> | null = null;
  let pdfjsP: Promise<PdfLibrary> | null = null;

  return async (bytes, filename, options, signal, hooks) => {
    rasterP ??= createSharpRaster();
    // The engine itself is a process-wide singleton; racing calls share the same load.
    ocrP ??= createRapidOcrServerEngine({ debug: opts.debug });
    pdfjsP ??= loadPdfLibrary();
    const [raster, ocrEngine, pdfjs] = await Promise.all([rasterP, ocrP, pdfjsP]);

    const parseOpts = toParseOptions(filename, options, signal, { raster, ocrEngine, pdfjs }, opts.limits);
    parseOpts.onPage = hooks?.onPage;
    parseOpts.convertToPdf = opts.convertToPdf;
    return parseDocument(bytes, parseOpts);
  };
}

/** The /ocr page service over the same RapidOCR singleton (+ sharp for TIFF/BMP/GIF/WebP pages). */
export function createOcrPageService(opts: { debug?: boolean } = {}): OcrPageService {
  let ocrP: Promise<OcrEngine> | null = null;
  return async (png, ctx) => {
    ocrP ??= createRapidOcrServerEngine({ debug: opts.debug });
    const engine = await ocrP;
    return engine.recognize(png, ctx);
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
  limits: RunnerLimits = DEFAULT_RUNNER_LIMITS,
): ParseOptions {
  const opts: ParseOptions = {
    filename,
    signal,
    raster: adapters.raster,
    ocrEngine: adapters.ocrEngine,
    pdfjs: adapters.pdfjs,
    maxBytes: Number.MAX_SAFE_INTEGER, // the HTTP layer enforces RUNNER_MAX_BYTES
    maxPages: clamp(options?.maxPages, 1, limits.maxOcrPages) ?? limits.maxOcrPages,
    perPageTimeoutMs: clamp(options?.perPageTimeoutMs, 1_000, 120_000) ?? DEFAULT_PER_PAGE_TIMEOUT_MS,
    maxChars: clamp(options?.maxChars, 100, limits.maxChars) ?? limits.maxChars,
  };
  if (options?.pageOutput === "single" || options?.pageOutput === "per-page") opts.pageOutput = options.pageOutput;
  if (typeof options?.languageHint === "string") opts.languageHint = options.languageHint.slice(0, 16);
  if (typeof options?.requestId === "string") opts.requestId = options.requestId.slice(0, 200);
  if (options?.vlmEndpoint?.url) {
    opts.vlm = createVisionEndpointGateway({ url: options.vlmEndpoint.url, headers: options.vlmEndpoint.headers });
  } else if (options?.vlm) {
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
