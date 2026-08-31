import { decodeText, extractDocx, extractXlsx } from "./office.js";
import { extractPageText, loadPdf } from "./pdf.js";
import { resolveOcr, resolveRaster, resolveStt } from "./runtime.js";
import { classifyDocument } from "./router/classify.js";
import { detectCapabilities } from "./router/capabilities.js";
import { routeDocument } from "./router/route.js";
import { executeRoute } from "./worker/ocr-worker.js";
import type { ExecuteRouteDeps, TextExtractor } from "./worker/ocr-worker.js";
import { createGraniteDoclingEngine } from "./ocr/granite-docling.js";
import { createVlmOcrEngine } from "./ocr/vlm.js";
import { createSttGatewayEngine, sttEngineAsOcr } from "./stt/engine.js";
import type {
  DocKind,
  OcrEngine,
  ParseOptions,
  ParsedDocument,
  ParsedMeta,
  SttEngine,
} from "./types.js";
import type { ExtractionEngine } from "./router/types.js";
import { abortError } from "./abort.js";

/**
 * Document text extraction, driven by the Intelligent Document Router.
 *
 * The pipeline is now three stages — **classify → route → execute** — instead of
 * the old linear per-kind fallback:
 *   1. {@link classifyDocument} makes one cheap pass → a {@link DocumentProfile}
 *      (kind / pages / scanned-vs-digital / script). Never throws for content.
 *   2. {@link routeDocument} turns (profile, capabilities) into an ordered plan
 *      ({@link RouteDecision}) — the routing matrix from ARCHITECTURE.md as code.
 *   3. {@link executeRoute} walks that plan, keeping the first strategy that
 *      yields usable text; the rest are targeted fallbacks, not brute force.
 *
 * This file owns only the *container* concerns: input normalisation, size guards,
 * wiring ParseOptions → executeRoute deps, and the global character cap. Engine
 * selection lives in the router. The browser off-main-thread path goes through the
 * worker (A9); this node/edge path calls executeRoute directly.
 *
 * **Never throws for content problems** — an unparseable file returns
 * `{ text: "", warnings: [...] }`. Throws only on programmer error (bad input
 * type) or when the caller's abort signal fires / is already aborted.
 */

const DEFAULTS = {
  maxBytes: 20 * 1024 * 1024, // 20 MB
  maxChars: 50_000,
  ocrFloor: 3, // min non-ws chars for a strategy's output to count as usable
  maxPages: 20, // page-image (OCR/VLM) strategy page budget
  perPageTimeoutMs: 30_000, // per-page rasterize + recognize timeout
} as const;

/** Anything that can be turned into document bytes. `File` (browser) extends `Blob`. */
export type ParseInput = Uint8Array | ArrayBuffer | Blob;

/* --------------------------------- helpers -------------------------------- */

async function normalizeInput(
  input: ParseInput,
  opts: ParseOptions,
): Promise<{ bytes: Uint8Array; filename?: string }> {
  let bytes: Uint8Array;
  let filename = opts.filename;

  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    // Blob / File
    const ab = await input.arrayBuffer();
    bytes = new Uint8Array(ab);
    const file = input as Blob & { name?: string };
    if (!filename && typeof file.name === "string") filename = file.name;
  }
  return { bytes, filename };
}

function emptyResult(kind: DocKind, warnings: string[]): ParsedDocument {
  const meta: ParsedMeta = {
    pagesProcessed: 0,
    totalPages: 0,
    nativePages: 0,
    ocrPages: 0,
    vlmPages: 0,
    sttPages: 0,
    truncated: false,
    chars: 0,
  };
  return { text: "", source: "none", pages: [], warnings, kind, meta };
}

/** Join every page's pdfjs text layer into one string (the pdfjs-text extractor). */
async function joinPdfText(
  bytes: Uint8Array,
  pdfjs: ParseOptions["pdfjs"],
  signal?: AbortSignal,
): Promise<string> {
  const { doc } = await loadPdf(bytes, pdfjs);
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (signal?.aborted) throw abortError();
    parts.push(await extractPageText(await doc.getPage(i)));
  }
  return parts.join("\n\n");
}

/**
 * Build the injected {@link ExecuteRouteDeps} from {@link ParseOptions}: text
 * extractors from the office/pdf modules, OCR engines from the injected (or
 * registered) OCR engine + VLM gateway + Granite, and the raster + pdfjs adapters.
 */
async function buildRouteDeps(
  opts: ParseOptions,
  capabilities: ReturnType<typeof detectCapabilities>,
  sttEngine: SttEngine | null,
): Promise<ExecuteRouteDeps> {
  const [ocr, raster] = await Promise.all([resolveOcr(opts), resolveRaster(opts)]);

  const engines: Partial<Record<ExtractionEngine, OcrEngine>> = {
    // resolveOcr honours opts.ocrEngine / opts.ocr:"off" / the registered engine;
    // a `none` engine (available:false) makes executeRoute skip the leg gracefully.
    rapidocr: ocr,
    // Granite is wired against the runtime; its real model download is a TODO
    // (throws on recognize), so a reached leg degrades to a warning + fall-through.
    "granite-docling": createGraniteDoclingEngine({
      mode: capabilities.runtime === "browser" ? "browser" : "edge",
      hasWebGPU: capabilities.hasWebGPU,
    }),
  };
  if (opts.vlm) {
    engines.vlm = createVlmOcrEngine(opts.vlm);
  }
  // Audio legs (Track 3): local Moonshine first when an engine is injected or
  // registered, then the external gateway. Audio bytes flow through the same
  // page-image machinery as images (the clip IS the single page).
  if (sttEngine) {
    engines.moonshine = sttEngineAsOcr(sttEngine, opts.sttLanguage);
  }
  if (opts.stt) {
    engines["stt-gateway"] = createSttGatewayEngine(opts.stt, opts.sttLanguage);
  }

  const extractors: Partial<Record<ExtractionEngine, TextExtractor>> = {
    mammoth: extractDocx,
    xlsx: async (b) => extractXlsx(b),
    text: async (b) => decodeText(b),
    "pdfjs-text": async (b, ctx) => joinPdfText(b, opts.pdfjs, ctx?.signal),
  };

  return {
    pdfjs: opts.pdfjs,
    raster,
    engines,
    extractors,
    usableFloor: opts.ocrFloor ?? DEFAULTS.ocrFloor,
  };
}

/** Enforce the global character cap on the routed result. */
function enforceMaxChars(doc: ParsedDocument, maxChars: number): ParsedDocument {
  if (doc.text.length <= maxChars) return doc;
  const text = doc.text.slice(0, maxChars);
  return {
    ...doc,
    text,
    warnings: [...doc.warnings, `truncated_chars:${doc.text.length}_to_${maxChars}`],
    meta: { ...doc.meta, truncated: true, chars: text.length },
  };
}

/* ------------------------------- main entry ------------------------------- */

/**
 * Extract text from a document. Runs unchanged in the browser, Node, and Deno/edge.
 *
 * Routes via classify → route → execute (see file header). **Never throws for
 * content problems** — an unparseable file returns `{ text: "", warnings: [...] }`.
 * Throws only on programmer error (bad input type) or abort.
 *
 * `maxPages` bounds how many pages a page-image (OCR/VLM) strategy rasterizes, and
 * `perPageTimeoutMs` bounds each rasterize/recognize step (defaults 20 / 30s); both
 * are enforced by `executeRoute` so a runaway page can't hang the parse.
 */
export async function parseDocument(
  input: ParseInput,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  if (input == null) throw new Error("parseDocument: input is required");
  if (options.signal?.aborted) throw abortError();

  const opts = options;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;

  const { bytes, filename } = await normalizeInput(input, opts);

  if (bytes.byteLength === 0) return emptyResult("other", ["empty_input"]);
  if (bytes.byteLength > maxBytes) {
    return emptyResult("other", [
      `input_too_large:${Math.round(bytes.byteLength / 1024)}KB_exceeds_${Math.round(maxBytes / 1024)}KB`,
    ]);
  }

  // 1) classify → profile (one cheap pass; never throws for content).
  const profile = await classifyDocument(bytes, filename, {
    pdfjs: opts.pdfjs,
    mime: opts.mime,
    signal: opts.signal,
  });

  // 2) route → ordered execution plan (the routing matrix as code).
  const capabilities = detectCapabilities();
  const sttEngine = resolveStt(opts);
  const route = routeDocument(profile, capabilities, {
    vlmEnabled: !!opts.vlm,
    sttLocalEnabled: !!sttEngine,
    sttGatewayEnabled: !!opts.stt,
  });

  // 3) execute → walk the plan, wiring engines/extractors from ParseOptions.
  const deps = await buildRouteDeps(opts, capabilities, sttEngine);
  const { document } = await executeRoute(
    {
      bytes,
      filename,
      profile,
      route,
      signal: opts.signal,
      maxPages: opts.maxPages ?? DEFAULTS.maxPages,
      perPageTimeoutMs: opts.perPageTimeoutMs ?? DEFAULTS.perPageTimeoutMs,
    },
    deps,
  );

  return enforceMaxChars(document, maxChars);
}
