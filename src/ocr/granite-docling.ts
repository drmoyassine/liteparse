import type { OcrContext, OcrEngine, OcrResult } from "../types.js";
import { abortError } from "../abort.js";

/**
 * IBM Granite-Docling-258M (ONNX) OCR engine.
 *
 * Granite-Docling is a 258M-parameter structure-aware document model: unlike a
 * plain det/rec OCR pipeline (rapidocr) it understands layout, tables, and
 * reading order, so it is the router's preferred strategy for complex scans when
 * it can run. It is heavier than rapidocr, so in the browser it is gated on
 * WebGPU; on the edge it is always available.
 *
 * Real ONNX inference is NOT wired here (no GPU in CI, and onnxruntime-web /
 * onnxruntime-node are optional peers that must never be imported at module top
 * level or the test bundle breaks). Instead this module exposes a fully mockable
 * seam: {@link GraniteDoclingOptions.sessionFactory} / `preprocess` / `postprocess`
 * are injectable, and a real call without injection fails loudly with a clear
 * "not implemented — see P4 / A8" message. The model download + InferenceSession
 * creation is wired in a later phase (A8/P2). What IS stable and tested here is
 * the engine contract: lazy warm-singleton session lifecycle, the recognition
 * pipeline, and the low-confidence fall-through that lets the cascade try the
 * next strategy.
 */

/**
 * Describes a Granite-Docling model artifact: where to fetch it, how big it is,
 * and which precision shard to use. The router never loads the model, so this is
 * metadata for the (later) real session factory, not a runtime dependency.
 */
export interface GraniteModelDescriptor {
  id: string;
  version: string;
  url: string;
  sizeHintBytes: number;
  precision: "int4" | "int8" | "fp16";
}

/**
 * Placeholder descriptor for the IBM Granite-Docling-258M ONNX model.
 *
 * `url` is the **runtime fetch origin — our S3 bucket**, not a direct HuggingFace
 * pull (HuggingFace is only the upstream we seed the bucket from). The concrete
 * URL/size/precision shard are deploy-configured and verified in P4; these values
 * are placeholders, intentionally not load-bearing for routing. The actual fetch
 * goes through the `ModelOrigin` adapter (Phase 2 / A8), with IndexedDB as the
 * local cache tier — see ARCHITECTURE.md → "Model Storage & Fetch".
 */
export const GRANITE_MODEL: GraniteModelDescriptor = {
  id: "granite-docling-258m",
  version: "1",
  url: "s3://liteparse-models/granite-docling-258M/int4/model.onnx",
  sizeHintBytes: 130_000_000,
  precision: "int4",
};

/**
 * Minimal ONNX `InferenceSession` surface this engine calls. Kept structural so
 * the optional onnxruntime peer never has to be imported here.
 */
export interface GraniteSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
  release(): Promise<void> | void;
}

export interface GraniteDoclingOptions {
  /** Where this engine will run — gates {@link OcrEngine.available}. */
  mode: "browser" | "edge";
  /** Browser mode gates `available`. Default false (no WebGPU ⇒ not available). */
  hasWebGPU?: boolean;
  /**
   * INJECT for tests. The real factory dynamic-imports onnxruntime, downloads the
   * model, and builds an InferenceSession; that wiring lands in A8/P2. When
   * omitted, the engine uses {@link realSessionFactory}, which throws a clear
   * TODO error — so a real call without injection fails loudly rather than
   * silently no-op'ing.
   */
  sessionFactory?: () => Promise<GraniteSession>;
  /** Image bytes → model input feeds. Default is the {@link defaultPreprocess} stub. */
  preprocess?: (image: Uint8Array) => Promise<Record<string, unknown>>;
  /** Model outputs → text (+ optional confidence). Default is the {@link defaultPostprocess} stub. */
  postprocess?: (
    outputs: Record<string, unknown>,
  ) => Promise<{ text: string; confidence?: number }>;
  /** Model artifact metadata. Defaults to {@link GRANITE_MODEL}. */
  model?: GraniteModelDescriptor;
  /**
   * Max image bytes `recognize` will accept before bailing (defense-in-depth
   * against a huge rasterised page that would OOM the worker). Oversized ⇒ throws,
   * so executeRoute logs a per-page warning and the cascade continues. Default 25 MB.
   */
  maxImageBytes?: number;
}

/** Default per-image size cap in `recognize` (defense-in-depth against OOM). */
const DEFAULT_MAX_IMAGE_BYTES = 25_000_000;

/**
 * Default preprocess stub. The real image→tensor transform (resize/normalise to
 * Granite's expected input, build the input feeds dict) is implemented in P4.
 * Inject `opts.preprocess` for tests; a real call without injection fails here.
 */
async function defaultPreprocess(_image: Uint8Array): Promise<Record<string, unknown>> {
  throw new Error(
    "granite-docling: real preprocess/postprocess not implemented - inject via opts, or see P4",
  );
}

/**
 * Default postprocess stub. The real outputs→text decode (tokeniser detokenise,
 * confidence aggregation) is implemented in P4. Inject `opts.postprocess` for
 * tests; a real call without injection fails here.
 */
async function defaultPostprocess(
  _outputs: Record<string, unknown>,
): Promise<{ text: string; confidence?: number }> {
  throw new Error(
    "granite-docling: real preprocess/postprocess not implemented - inject via opts, or see P4",
  );
}

/**
 * The session factory used when {@link GraniteDoclingOptions.sessionFactory} is
 * NOT injected. Deliberately a TODO: model download + onnxruntime
 * `InferenceSession` creation is wired in A8/P2. We must NOT import
 * onnxruntime-web / onnxruntime-node at module top level (optional peers; they
 * would break the test bundle), and the dynamic import belongs to that later
 * phase too. The seam (the `sessionFactory` option) is what is fully tested.
 */
async function realSessionFactory(): Promise<GraniteSession> {
  throw new Error(
    "granite-docling: model download + InferenceSession creation is wired in A8/P2",
  );
}

/**
 * Build a Granite-Docling {@link OcrEngine}.
 *
 * The ONNX session is created lazily on the first `recognize()` call via
 * `sessionFactory` and then cached (warm singleton) for the engine's lifetime,
 * so repeated calls reuse one session. Recognition runs preprocess → session.run
 * → postprocess, and a low-confidence (`< 0.2`) or empty result falls through as
 * `{ text: "" }` so the document cascade can try the next strategy.
 */
export function createGraniteDoclingEngine(opts: GraniteDoclingOptions): OcrEngine {
  const mode = opts.mode;
  const hasWebGPU = opts.hasWebGPU ?? false;
  const preprocess = opts.preprocess ?? defaultPreprocess;
  const postprocess = opts.postprocess ?? defaultPostprocess;
  const factory = opts.sessionFactory ?? realSessionFactory;
  // opts.model is accepted for forward-compat (the real factory will use it); it
  // has no behavioural effect until A8/P2 wires the download.
  void opts.model;
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  // A real factory must be injected for the engine to be `available`. Without one,
  // recognize() always throws (the TODO stub), so claiming availability only
  // wastes page rendering before the cascade falls through — gate it honestly.
  const hasSessionFactory = opts.sessionFactory !== undefined;

  // Warm singleton: created lazily on the first recognize() call, then cached for
  // the engine's lifetime. Stored as a promise so two concurrent first calls
  // share one session instead of racing to create two. A *failed* creation (sync
  // throw or async rejection) clears the cache so the next call retries rather
  // than reusing a permanent rejection — one transient blip must not brick the
  // engine for life (P4 / R4: poisoned-singleton fix).
  let sessionPromise: Promise<GraniteSession> | null = null;

  async function ensureSession(): Promise<GraniteSession> {
    if (!sessionPromise) {
      const created = (async () => factory())();
      sessionPromise = created.catch((err) => {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  }

  return {
    name: "granite-docling",
    available: hasSessionFactory ? (mode === "edge" ? true : hasWebGPU) : false,
    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      // 1. Empty / zero-byte image → empty result (and crucially do NOT spin up
      //    a session: an empty page should never trigger a model download).
      if (image.byteLength === 0) {
        return { text: "" };
      }
      // 1b. Defense-in-depth: an oversized image would OOM the worker before
      //     inference even starts. Bail with a clear throw so executeRoute logs
      //     it as a per-page warning and the cascade continues (P4 / R4).
      if (image.byteLength > maxImageBytes) {
        throw new Error(
          `granite-docling: image too large (${image.byteLength} > ${maxImageBytes} bytes)`,
        );
      }
      // 2. Honor a pre-aborted signal before any heavy work.
      if (ctx.signal?.aborted) {
        throw abortError();
      }
      // 3. Ensure the ONNX session (lazy-create via sessionFactory, cached).
      const session = await ensureSession();
      // 4. Image bytes → model input feeds.
      const feeds = await preprocess(image);
      // 5. Run inference.
      const outputs = await session.run(feeds);
      // 6. Model outputs → text (+ optional confidence).
      const { text, confidence } = await postprocess(outputs);
      // 6b. Honor an abort that fired during the (potentially long) inference.
      //     ONNX session.run can't be cancelled mid-flight, but we can discard
      //     its result instead of returning it past an abort (P4 / R4).
      if (ctx.signal?.aborted) {
        throw abortError();
      }
      // 7. Low-confidence / empty fall-through so the cascade can try the next
      //    strategy instead of returning garbage.
      if ((confidence !== undefined && confidence < 0.2) || text.length === 0) {
        return { text: "" };
      }
      // 8. Usable result — trim whitespace, pass confidence through.
      return { text: text.trim(), confidence };
    },
  };
}
