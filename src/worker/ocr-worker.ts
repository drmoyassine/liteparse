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
import type { ExtractionEngine } from "../router/types.js";
import type { DictionaryCheck, OcrEngine, PdfLibrary, RasterAdapter } from "../types.js";
import type { JobId, ParseRequest, ProgressStage, WorkerInbound, WorkerOutbound } from "./protocol.js";
import { executeRoute } from "./execute.js";
import type { ExecuteRouteDeps, RouteProgress, TextExtractor } from "./execute.js";
import { extractCsv, extractDocx, extractXlsx } from "../office.js";
import { extractOffice } from "../formats/index.js";
import { decodeWithDetection } from "../text/encoding.js";
import { getBrowserOcrEngine, getBrowserSttEngine } from "../runtime.js";
import { sttEngineAsOcr } from "../stt/engine.js";
import { createThrowModelOrigin } from "./model-origin.js";
import type { ModelOrigin } from "./model-origin.js";

export { executeRoute } from "./execute.js";
export type { ExecuteRouteInput, ExecuteRouteDeps, ExecuteRouteResult, RouteProgress, TextExtractor, ExtractedPages } from "./execute.js";

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

/** Worker defaults sized for long AMS uploads (141 pages / 130k chars fit comfortably). */
export const WORKER_DEFAULTS = { maxPages: 300, maxChars: 2_000_000, perPageTimeoutMs: 60_000 } as const;

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
  /** Runner-hosted RapidOCR for "edge" pages (Arabic / over the browser page cap). See createRunnerOcrEngine. */
  runnerOcr?: OcrEngine;
  /** Optional dictionary check on native pages. */
  dictionary?: DictionaryCheck;
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

/** Build the {@link ExecuteRouteDeps} from config + the registered browser engines. */
function buildWorkerDeps(): ExecuteRouteDeps {
  const registered = getBrowserOcrEngine();
  const registeredStt = getBrowserSttEngine();
  return {
    pdfjs: workerConfig.pdfjs,
    raster: workerConfig.raster,
    engines: {
      ...(registered ? { rapidocr: registered } : {}),
      ...(registeredStt ? { moonshine: sttEngineAsOcr(registeredStt) } : {}),
      ...workerConfig.engines,
    },
    extractors: { ...defaultExtractors(), ...workerConfig.extractors },
    runnerOcr: workerConfig.runnerOcr,
    dictionary: workerConfig.dictionary,
  };
}

/** The document-level extractors shared by the worker and parseDocument. */
export function defaultExtractors(): Partial<Record<ExtractionEngine, TextExtractor>> {
  return {
    mammoth: async (b) => extractDocx(b),
    xlsx: async (b, ctx) => {
      if (ctx.kind === "csv") {
        const { text, encoding } = extractCsv(b);
        return { pages: [text], encoding, format: "csv" };
      }
      return extractXlsx(b);
    },
    text: async (b) => {
      const { text, encoding } = decodeWithDetection(b);
      return { pages: [text], encoding };
    },
    office: async (b, ctx) => extractOffice((ctx.kind ?? "other") as never, b),
  };
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
        maxPages: req.options?.maxPages ?? WORKER_DEFAULTS.maxPages,
        maxChars: req.options?.maxChars ?? WORKER_DEFAULTS.maxChars,
        perPageTimeoutMs: req.options?.perPageTimeoutMs ?? WORKER_DEFAULTS.perPageTimeoutMs,
        pageOutput: req.options?.pageOutput,
        languageHint: req.options?.languageHint,
        requestId: req.options?.requestId,
      },
      {
        ...buildWorkerDeps(),
        onPage: (page) => scope.postMessage({ type: "page", id: req.id, page } satisfies WorkerOutbound),
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
