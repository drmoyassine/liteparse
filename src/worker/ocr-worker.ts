/**
 * The router's Web Worker — owns the entire browser document pipeline.
 *
 * Two layers, deliberately separated:
 *
 * 1. **`executeRoute` — the pure, fully unit-tested core.** It walks a
 *    {@link RouteDecision} in order, running the wired extractor/engine for each
 *    strategy and keeping the first that yields usable text. Every dep (pdfjs,
 *    raster, engines, extractors, progress) is *injected*, so the core is tested
 *    with fakes — no ONNX / WebGPU / real worker in CI.
 *
 * 2. **The thin worker shell** (bottom of file). It wires `onmessage` →
 *    `executeRoute` → `postMessage`, tracks per-job abort, and constructs the real
 *    deps from the consumer's {@link configureWorker} config + the registered
 *    browser OCR engine. The shell self-installs only inside an actual worker
 *    global scope, so importing this module in Node/tests has no side effects.
 *
 * See ARCHITECTURE.md → Web Worker Architecture, ROADMAP.md → Phase 2 (A8).
 */
import type {
  DocumentProfile,
  ExtractionEngine,
  RouteDecision,
} from "../router/types.js";
import type {
  DocumentSource,
  OcrEngine,
  Page,
  PageSource,
  ParsedDocument,
  PdfLibrary,
  RasterAdapter,
} from "../types.js";
import type {
  JobId,
  ParseRequest,
  ProgressStage,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import { loadPdf, extractPageText } from "../pdf.js";
import { extractDocx, extractXlsx } from "../office.js";
import { getBrowserOcrEngine } from "../runtime.js";
import { createThrowModelOrigin } from "./model-origin.js";
import type { ModelOrigin } from "./model-origin.js";
import { abortError, isAbortError } from "../abort.js";

// ─── engine taxonomy ─────────────────────────────────────────────────────────

/** Engines that read text directly from bytes (no page rasterisation). */
const TEXT_ENGINES: ReadonlySet<ExtractionEngine> = new Set([
  "pdfjs-text",
  "mammoth",
  "xlsx",
  "text",
]);

function isTextEngine(engine: ExtractionEngine): boolean {
  return TEXT_ENGINES.has(engine);
}

/** Map an engine to the {@link PageSource} its output carries. */
function engineToSource(engine: ExtractionEngine): PageSource {
  switch (engine) {
    case "pdfjs-text":
    case "mammoth":
    case "xlsx":
    case "text":
      return "native";
    case "rapidocr":
    case "granite-docling":
      return "ocr";
    case "vlm":
      return "vlm";
  }
}

/** Map an engine to the {@link ProgressStage} reported while it runs. */
function engineToStage(engine: ExtractionEngine): ProgressStage {
  switch (engine) {
    case "rapidocr":
      return "rapidocr";
    case "granite-docling":
      return "granite";
    case "vlm":
      return "vlm";
    default:
      return "finalizing";
  }
}

function nonWsLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}

/** Assemble a {@link ParsedDocument} from the pages a strategy produced. */
function buildParsedDocument(
  profile: DocumentProfile,
  pages: Page[],
  warnings: string[],
): ParsedDocument {
  const text = pages.map((p) => p.text).filter((t) => t.length > 0).join("\n\n");
  let source: DocumentSource = "none";
  if (pages.length > 0) {
    const first = pages[0]?.source;
    const allSame = first !== undefined && pages.every((p) => p.source === first);
    source = allSame && first ? first : "mixed";
  }
  return {
    text,
    source,
    pages,
    warnings,
    kind: profile.kind,
    meta: {
      pagesProcessed: pages.length,
      totalPages: pages.length || profile.pages || 1,
      nativePages: pages.filter((p) => p.source === "native").length,
      ocrPages: pages.filter((p) => p.source === "ocr").length,
      vlmPages: pages.filter((p) => p.source === "vlm").length,
      truncated: false,
      chars: text.length,
    },
  };
}

// ─── executeRoute core ───────────────────────────────────────────────────────

/** A document-level text extractor (mammoth / xlsx / text / pdfjs-text). */
export type TextExtractor = (
  bytes: Uint8Array,
  ctx: { filename?: string; signal?: AbortSignal },
) => Promise<string>;

/** Per-page progress emitted while a strategy runs (mapped to a ProgressEvent by the shell). */
export interface RouteProgress {
  pageIndex: number;
  totalPages: number;
  stage: ProgressStage;
  engine?: ExtractionEngine;
}

export interface ExecuteRouteInput {
  bytes: Uint8Array;
  filename?: string;
  profile: DocumentProfile;
  route: RouteDecision;
  signal?: AbortSignal;
  /**
   * Cap on how many pages a page-image (OCR/VLM) strategy will raster+recognize,
   * so a huge scanned PDF can't pin the worker. `<= 0` / unset ⇒ uncapped. The
   * container {@link parseDocument} applies a product default (P4 / R2-A).
   */
  maxPages?: number;
  /**
   * Per-page timeout (ms) for rasterize + recognize. `<= 0` / unset ⇒ no timeout
   * (rely on the caller's overall budget). On timeout the page is skipped (empty +
   * warning) and the cascade continues; a stuck engine can't hang the whole parse
   * (P4 / R2-A).
   */
  perPageTimeoutMs?: number;
}

/** All injectable dependencies. Everything not provided is skipped (with a warning). */
export interface ExecuteRouteDeps {
  pdfjs?: PdfLibrary;
  raster?: RasterAdapter;
  /** OCR / vision engines keyed by tag. Missing or unavailable ⇒ strategy skipped. */
  engines?: Partial<Record<ExtractionEngine, OcrEngine>>;
  /** Document-level text extractors keyed by tag. Missing ⇒ strategy skipped. */
  extractors?: Partial<Record<ExtractionEngine, TextExtractor>>;
  /** Progress callback (one per page/stage). */
  onProgress?: (e: RouteProgress) => void;
  /** Min non-whitespace chars for a strategy's output to count as usable. Default 3. */
  usableFloor?: number;
}

export interface ExecuteRouteResult {
  document: ParsedDocument;
  /** Engine tag that produced the text; `undefined` if nothing yielded usable text. */
  engine?: ExtractionEngine;
}

/**
 * Race a promise against a timeout. `ms <= 0` ⇒ no timeout (return the promise as-is).
 * On timeout, reject with a labelled `Error` and swallow any late rejection from the
 * orphaned promise so it can't surface as an unhandled-rejection (P4 / R2-A).
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number | undefined,
  label: string,
): Promise<T> {
  if (!ms || ms <= 0) return p;
  // Attach a no-op catch immediately so a rejection arriving after the timeout
  // fires is consumed here, not reported as an unhandled rejection.
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Wrap a progress callback so it doesn't flood the main thread (one postMessage per
 * page can be hundreds/sec on a big PDF). Emits eagerly on a stage change or the
 * final page, and otherwise at most every `MIN_GAP_MS` (P4 / R2-H).
 */
function makeThrottledProgress(emit: (e: RouteProgress) => void): (e: RouteProgress) => void {
  const MIN_GAP_MS = 250;
  let lastEmit = -Infinity;
  let lastStage: ProgressStage | undefined;
  return (e) => {
    const now = Date.now();
    const isLastPage = e.totalPages > 0 && e.pageIndex >= e.totalPages - 1;
    const stageChanged = lastStage === undefined || e.stage !== lastStage;
    if (stageChanged || isLastPage || now - lastEmit >= MIN_GAP_MS) {
      lastEmit = now;
      lastStage = e.stage;
      emit(e);
    }
  };
}

/**
 * Render the page images a vision/OCR engine needs.
 *
 * - PDF: open with pdfjs, rasterise every page via `deps.raster` (OffscreenCanvas
 *   in the worker). Requires both `pdfjs` and `raster`.
 * - Image / anything else: the bytes are the single page image.
 */
async function renderPageImages(
  input: ExecuteRouteInput,
  deps: ExecuteRouteDeps,
): Promise<{ images: Uint8Array[]; totalPages: number; warning?: string }> {
  if (input.profile.kind === "pdf") {
    if (!deps.pdfjs) throw new Error("pdf OCR requires a pdfjs instance");
    if (!deps.raster) throw new Error("pdf OCR requires a raster adapter");
    const { doc } = await loadPdf(input.bytes, deps.pdfjs);
    const fullPages = doc.numPages;
    // Page budget: cap how many pages an OCR/VLM strategy rasterizes+recognizes, so
    // a 500-page scanned PDF can't pin the worker for minutes. `maxPages <= 0` ⇒
    // uncapped. (P4 / R2-A.)
    const cap = input.maxPages && input.maxPages > 0 ? input.maxPages : undefined;
    const totalPages = cap ? Math.min(fullPages, cap) : fullPages;
    let warning: string | undefined;
    if (cap && totalPages < fullPages) {
      warning = `page_budget: capped OCR/VLM at ${totalPages} of ${fullPages} pages`;
    }
    const images: Uint8Array[] = [];
    for (let i = 0; i < totalPages; i++) {
      if (input.signal?.aborted) throw abortError();
      deps.onProgress?.({ pageIndex: i, totalPages, stage: "rendering" });
      // Per-page raster timeout (P4 / R2-A). On timeout this throws → the caller
      // logs a per-page warning and the loop is bounded, not hung.
      images.push(
        await withTimeout(
          deps.raster.rasterizePdfPage(doc, i),
          input.perPageTimeoutMs,
          "render",
        ),
      );
    }
    return { images, totalPages, warning };
  }
  // image / other: the bytes themselves are the (single) page image.
  return { images: [input.bytes], totalPages: input.profile.pages || 1 };
}

/**
 * Execute a routed plan. Walks `route.strategies` in order; the first strategy to
 * yield ≥ `usableFloor` non-whitespace chars wins and is returned. Strategies with
 * no wired extractor/engine, or that fail / under-yield, are recorded as warnings
 * and the walk continues — the targeted, non-brute-force cascade from ARCHITECTURE.
 *
 * `strategy.location` (browser vs edge) is **advisory only** here: executeRoute runs
 * whatever engine/extractor is wired into the local deps regardless of where a
 * strategy nominally targets. True edge-HTTP dispatch — running a remote strategy in
 * the serverless mesh instead of locally — is a P5 concern; until then a strategy
 * tagged `location: "edge"` simply runs its wired local engine if one is present.
 *
 * `input.maxPages` bounds how many pages a page-image strategy rasterizes, and
 * `input.perPageTimeoutMs` bounds each rasterize/recognize step, so a runaway page
 * can't hang the whole parse (P4 / R2-A).
 *
 * Never throws for a strategy failure (those become warnings); only propagates an
 * `AbortError` (name `"AbortError"`) when the caller's signal fires.
 */
export async function executeRoute(
  input: ExecuteRouteInput,
  deps: ExecuteRouteDeps = {},
): Promise<ExecuteRouteResult> {
  const usableFloor = deps.usableFloor ?? 3;
  const warnings: string[] = [];

  for (const strategy of input.route.strategies) {
    if (input.signal?.aborted) throw abortError();

    // ── Document-level text extractor ──
    if (isTextEngine(strategy.engine)) {
      const extractor = deps.extractors?.[strategy.engine];
      if (!extractor) {
        warnings.push(`${strategy.engine}: no extractor wired, skipping`);
        continue;
      }
      let text: string;
      try {
        text = await extractor(input.bytes, {
          filename: input.filename,
          signal: input.signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        warnings.push(`${strategy.engine} extractor failed: ${(err as Error).message}`);
        continue;
      }
      const chars = nonWsLen(text);
      if (chars >= usableFloor) {
        const pages: Page[] = [
          { index: 0, text: text.trim(), source: engineToSource(strategy.engine) },
        ];
        deps.onProgress?.({
          pageIndex: 0,
          totalPages: input.profile.pages || 1,
          stage: "finalizing",
          engine: strategy.engine,
        });
        return {
          document: buildParsedDocument(input.profile, pages, warnings),
          engine: strategy.engine,
        };
      }
      warnings.push(`${strategy.engine}: only ${chars} non-ws chars, falling through`);
      continue;
    }

    // ── Page-image OCR / vision engine ──
    const engine = deps.engines?.[strategy.engine];
    if (!engine) {
      warnings.push(`${strategy.engine}: engine not wired, skipping`);
      continue;
    }
    if (!engine.available) {
      warnings.push(`${engine.name}: unavailable in this runtime, skipping`);
      continue;
    }

    let rendered: { images: Uint8Array[]; totalPages: number; warning?: string };
    try {
      rendered = await renderPageImages(input, deps);
    } catch (err) {
      if (isAbortError(err)) throw err;
      warnings.push(`${strategy.engine}: render failed (${(err as Error).message}), skipping`);
      continue;
    }
    if (rendered.warning) warnings.push(rendered.warning);

    const { images, totalPages } = rendered;
    const source = engineToSource(strategy.engine);
    const stage = engineToStage(strategy.engine);
    const pages: Page[] = [];
    for (let i = 0; i < images.length; i++) {
      if (input.signal?.aborted) throw abortError();
      const img = images[i];
      if (!img) continue;
      deps.onProgress?.({ pageIndex: i, totalPages, stage, engine: strategy.engine });
      try {
        // Per-page recognize timeout (P4 / R2-A): a stuck engine rejects with a
        // timeout Error → caught below as a page failure (empty + warning), not a
        // hang. An abort rejects with an AbortError → re-thrown to the caller.
        const out = await withTimeout(
          engine.recognize(img, {
            pageIndex: i,
            totalPages,
            signal: input.signal,
          }),
          input.perPageTimeoutMs,
          engine.name,
        );
        pages.push({ index: i, text: (out.text ?? "").trim(), source });
      } catch (err) {
        if (isAbortError(err)) throw err;
        pages.push({ index: i, text: "", source });
        warnings.push(`${engine.name}: page ${i} failed (${(err as Error).message})`);
      }
    }

    const chars = pages.reduce((n, p) => n + nonWsLen(p.text), 0);
    if (chars >= usableFloor) {
      return {
        document: buildParsedDocument(input.profile, pages, warnings),
        engine: strategy.engine,
      };
    }
    warnings.push(
      `${engine.name}: ${chars} non-ws chars across ${pages.length} page(s), falling through`,
    );
  }

  // No strategy yielded usable text → empty doc (source "none") with diagnostic warnings.
  return {
    document: buildParsedDocument(input.profile, [], warnings),
    engine: undefined,
  };
}

// ─── worker configuration seam (consumer wires real engines / origin / raster) ─

export interface WorkerConfig {
  /** Configured pdfjs instance (avoids CDN/worker setup). */
  pdfjs?: PdfLibrary;
  /** Raster adapter for rendering PDF pages (OffscreenCanvas in the worker). */
  raster?: RasterAdapter;
  /** OCR / vision engines keyed by tag (rapidocr/granite-docling/vlm). */
  engines?: Partial<Record<ExtractionEngine, OcrEngine>>;
  /** Override/add document-level text extractors. */
  extractors?: Partial<Record<ExtractionEngine, TextExtractor>>;
  /**
   * S3-backed model origin for fetching model weights on a cache miss. Defaults to
   * a throw-origin; inject a real one so model-bearing strategies can load weights
   * (see {@link resolveModel}).
   */
  modelOrigin?: ModelOrigin;
}

let workerConfig: WorkerConfig = {};

/** Configure the worker's injected deps (call once at worker init, before messages). */
export function configureWorker(cfg: WorkerConfig): WorkerConfig {
  workerConfig = { ...workerConfig, ...cfg };
  return workerConfig;
}

/** The configured model origin (throws by default until the consumer injects S3). */
export function getWorkerModelOrigin(): ModelOrigin {
  return workerConfig.modelOrigin ?? createThrowModelOrigin();
}

/** Build the {@link ExecuteRouteDeps} from config + the registered browser OCR engine. */
function buildWorkerDeps(): ExecuteRouteDeps {
  const registered = getBrowserOcrEngine();
  return {
    pdfjs: workerConfig.pdfjs,
    raster: workerConfig.raster,
    engines: {
      ...(registered ? { rapidocr: registered } : {}),
      ...workerConfig.engines,
    },
    extractors: {
      mammoth: async (b) => extractDocx(b),
      xlsx: async (b) => extractXlsx(b),
      text: async (b) => new TextDecoder("utf-8", { fatal: false }).decode(b),
      "pdfjs-text": async (b, ctx) => extractPdfText(b, ctx.signal),
      ...workerConfig.extractors,
    },
  };
}

/** pdfjs-text extractor: opens the PDF and joins every page's text layer. */
async function extractPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  console.log("[extractPdfText] START", { bytes: bytes.length });
  const { doc } = await loadPdf(bytes, workerConfig.pdfjs);
  console.log("[extractPdfText] PDF opened, numPages:", doc.numPages);
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (signal?.aborted) throw abortError();
    parts.push(await extractPageText(await doc.getPage(i)));
  }
  const text = parts.join("\n\n");
  console.log("[extractPdfText] DONE, text length:", text.length);
  return text;
}

// ─── worker shell (self-installs only inside a real worker scope) ────────────

interface WorkerScope {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** True only inside a DedicatedWorkerGlobalScope (not Node, not the main thread). */
function isWorkerScope(): boolean {
  const g = globalThis as unknown as { self?: unknown; window?: unknown };
  return typeof g.self !== "undefined" && g.self !== g.window;
}

function workerScope(): WorkerScope {
  return globalThis as unknown as WorkerScope;
}

const inflight = new Map<JobId, AbortController>();

async function handleParse(req: ParseRequest): Promise<void> {
  console.log("[handleParse] received parse request", {
    id: req.id,
    filename: req.filename,
    kind: req.profile?.kind,
    strategies: req.route?.strategies?.map((s: { engine?: unknown }) => s.engine),
  });
  const ac = new AbortController();
  inflight.set(req.id, ac);
  const scope = workerScope();
  try {
    const result = await executeRoute(
      {
        bytes: new Uint8Array(req.bytes),
        filename: req.filename,
        profile: req.profile,
        route: req.route,
        signal: ac.signal,
      },
      {
        ...buildWorkerDeps(),
        // Throttle per-page progress so a big PDF can't flood the main thread with
        // hundreds of postMessages/sec (P4 / R2-H). Eager on stage change / last page.
        onProgress: makeThrottledProgress((e) =>
          scope.postMessage({
            type: "progress",
            id: req.id,
            pageIndex: e.pageIndex,
            totalPages: e.totalPages,
            stage: e.stage,
            engine: e.engine,
          } satisfies WorkerOutbound),
        ),
      },
    );
    scope.postMessage({
      type: "result",
      id: req.id,
      document: result.document,
      engine: result.engine,
    } satisfies WorkerOutbound);
  } catch (err) {
    console.error("[handleParse] ERROR", (err as Error)?.message || err, (err as Error)?.stack);
    scope.postMessage({
      type: "error",
      id: req.id,
      message: (err as Error).message || "worker error",
    } satisfies WorkerOutbound);
  } finally {
    inflight.delete(req.id);
  }
}

function installWorker(): void {
  console.log("[installWorker] installing onmessage handler; isWorkerScope() was true");
  const scope = workerScope();
  scope.onmessage = (ev: { data: unknown }) => {
    const msg = ev.data as WorkerInbound | undefined;
    // Capture the type BEFORE the union-narrowing branches below exhaust `WorkerInbound`
    // to `never`, so the final "unrecognized type" diagnostic can still read it.
    const rawType = (msg as { type?: unknown } | undefined)?.type;
    const rawId = (msg as { id?: unknown } | undefined)?.id;
    // ALWAYS log message arrival (before the type check) so a broken/overwritten handler
    // or a malformed payload is visible. The #1 symptom this catches: a worker that loads
    // and installs onmessage but where handleParse never runs (message never matched).
    console.log("[worker onmessage] dispatch", { type: rawType, id: rawId });
    if (!msg || typeof msg !== "object") {
      console.log("[worker onmessage] non-object/null message, ignoring", { msg });
      return;
    }
    if (msg.type === "cancel") {
      inflight.get(msg.id)?.abort();
      inflight.delete(msg.id);
      return;
    }
    if (msg.type === "parse") {
      void handleParse(msg);
      return;
    }
    console.log("[worker onmessage] UNRECOGNIZED message type, ignoring", { type: rawType });
  };
  console.log("[installWorker] onmessage assigned; typeof:", typeof scope.onmessage);
}

if (isWorkerScope()) {
  console.log("[ocr-worker] worker scope detected, calling installWorker()");
  installWorker();
} else {
  console.log("[ocr-worker] NOT a worker scope (isWorkerScope=false); onmessage NOT installed");
}
