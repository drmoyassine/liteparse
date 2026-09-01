/**
 * RapidOCR browser runner on onnxruntime-web.
 *
 * Implements PP-OCRv4 detection (DB algorithm) and recognition (CTC) using ONNX models
 * fetched from HuggingFace and cached in IndexedDB. Adapted to liteparse's OcrRunner
 * contract.
 *
 * Architecture:
 * - Load det/rec ONNX models via resolveModel (HF source → IndexedDB cache)
 * - Detection: preprocess image → det session → DB post-processing → bounding boxes
 * - Recognition: crop boxes → rec session → CTC decode → text
 *
 * References:
 * - PP-OCR paper: https://arxiv.org/abs/2207.01010
 * - DB algorithm: https://arxiv.org/abs/1902.06179
 * - RapidOCR (Python reference): https://github.com/RapidAI/RapidOCR
 */

// Load the WASM-ONLY (non-jsep) build LAZILY. The default `onnxruntime-web`
// export resolves to the jsep-capable bundle, which in the browser loads
// `ort-wasm-simd-threaded.jsep.wasm` (built for WebGPU). That jsep build run as
// pure-CPU WASM computes NaN. The `./wasm` subpath gives the plain SIMD WASM
// build — verified finite for this model in isolation (onnxruntime-web/wasm +
// native EP both produce 0 NaN). We do CPU-only OCR, no WebGPU.
//
// The import is dynamic, not static: onnxruntime-web is a peerDependency, and
// the main liteparse index re-exports this module — a static import made
// `import "@drmoyassine/liteparse"` crash at module-link time (ERR_MODULE_NOT_FOUND) for any
// consumer that installs without the peer (Node/Deno runtimes; first seen in
// the apps/runner Docker image). pdfjs-dist (pdf.ts) and onnxruntime-node
// (ocr/rapidocr-server.ts) are dynamic for the same reason. ort is loaded once
// on the first init(); nothing at module scope touches it.
type OrtWasm = typeof import("onnxruntime-web/wasm");
let ortPromise: Promise<OrtWasm> | undefined;
async function loadOrt(): Promise<OrtWasm> {
  ortPromise ??= import("onnxruntime-web/wasm").then((mod) => {
    // Load probe (moved from module scope along with the lazy import): confirms
    // the ort import succeeded and env.wasm is present. With the dynamic import
    // a load failure no longer crashes module eval — it surfaces at the first
    // init() call, where the engine's error handling reports it. ALWAYS LOGGED
    // (not dbg-gated) so production failures stay visible.
    const g = globalThis as typeof globalThis & {
      crossOriginIsolated?: boolean;
      navigator?: { hardwareConcurrency?: number };
    };
    console.log(
      "[rapidocr-onnx-runner] ort module loaded; env.wasm present:",
      !!mod.env?.wasm,
      "| crossOriginIsolated:", g.crossOriginIsolated ?? false,
      "| numThreads target:", g.crossOriginIsolated ? Math.max(1, (g.navigator?.hardwareConcurrency ?? 2) - 1) : 1,
    );
    return mod;
  });
  return ortPromise;
}
// Type-only import from the REAL source package. onnxruntime-web re-exports InferenceSession/
// Tensor via an ambient `declare module 'onnxruntime-web/wasm' { export * }` chain, which (under
// tsup's DTS worker) exposes only the `const` value binding, not the interface — so namespace or
// named type access from "onnxruntime-web/wasm" errors TS2749 (value used as type). Importing the
// interfaces from onnxruntime-common directly (its real dist .d.ts, not an ambient shim) gives the
// instance types. Runtime value access stays `ort.X` (ort.InferenceSession.create / new ort.Tensor /
// ort.env). onnxruntime-common is a transitive dep of onnxruntime-web, so consumers always have it.
import type { InferenceSession, Tensor } from "onnxruntime-common";
import type { ModelDescriptor, ModelOrigin } from "../../worker/model-origin.js";
import { resolveModel, createThrowModelOrigin } from "../../worker/model-origin.js";
import type { OcrRunner } from "../../ocr/rapidocr.js";
// NOTE: this module MUST NOT import from "../../worker/ocr-worker.js".
// ocr-worker.ts carries the self-installing worker shell (`if (isWorkerScope())
// installWorker()`), and because this runner is published under the separate
// `@drmoyassine/liteparse/engines/rapidocr` subpath (its own tsup bundle), importing the shell
// here bakes a SECOND copy of it into that bundle. The worker then loads two shell
// instances — the subpath's installWorker() runs second and overwrites the real
// onmessage, but reads a workerConfig that configureWorker never wrote to, so
// deps.engines.rapidocr is undefined → "rapidocr: engine not wired, skipping".
// The model origin is INJECTED (createRapidOcrRunner({ modelOrigin })) instead of
// read from global worker config, so this module has no dependency on the shell.
import { dbPostProcess, DEFAULT_DB_PARAMS, setDbPostProcessDebug, type DBParams } from "./db-postprocess.js";
// Runtime-agnostic decode/geometry/quality modules shared with the server engine
// (ocr/rapidocr-server.ts) — single source of the CTC layout knowledge, the
// reading-order sort, and the OCR quality gates (calibrated in ocr-lab).
import { createCtcDecoder } from "./shared/ctc-decode.js";
import { readingOrderSort } from "./shared/reading-order.js";
import {
  lengthWeightedConfidence,
  minBoxSide,
  OCR_CONFIDENCE_FLOOR,
  PER_BOX_CONFIDENCE_FLOOR,
  MIN_BOX_SIDE_PX,
  type TextBox,
} from "./shared/quality.js";

// ── Telemetry gate ─────────────────────────────────────────────────────────────
// The runner emits a lot of OCR-quality/latency telemetry (init timing, det/rec stats, box
// geometry, CTC layout). It's invaluable when integrating or tuning — and noise in a quiet
// production build. `createRapidOcrRunner({ debug })` flips this flag; default is ON so any
// deployment sees the diagnostics out of the box. Consumers that want prod-quiet pass
// `debug: import.meta.env.DEV` (or simply `debug: false`). Gated via the `dbg()` helper; real
// error paths (eager-warm-up failure) stay on console.warn unconditionally.
let DEBUG = true;
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// (The module-load probe that used to live here moved into loadOrt() above,
// together with the lazy import — nothing at module scope may touch ort.)

// PP-OCR model IDs (must match toModelUrl mapping in model-origin-hf.ts)
const DET_MODEL_ID = "pp-ocrv4-det-latin";
const REC_MODEL_ID = "pp-ocrv4-rec-latin";
const DICT_MODEL_ID = "pp-ocrv4-dict-latin";
const MODEL_VERSION = "1.1.0"; // bumped from 1.0.0 → forces IndexedDB cache miss (no stale v3 bytes)
// The dict gets its OWN cache key, bumped independently of det/rec. The dict SOURCE was
// corrected (monkt 436-char multilingual symbol set → canonical PaddleOCR 94-char English
// dict); bumping only this key forces resolveModel to re-fetch the small dict while the
// large det (~10MB) + rec models — which are UNCHANGED — stay cached in IndexedDB.
const DICT_VERSION = "1.2.0";

// ── THREADING A/B KNOB (diagnostic) ──────────────────────────────────────────
// 0 = auto (cores-1 when cross-origin-isolated, else 1). Set to 1 to force
// single-threaded and compare µs/width-unit against the auto run — a same-image
// A/B that directly measures whether ort's pthread pool accelerates inference
// (the @7 baseline is already in the smoke log; one forced-1 reload completes it).
// ort reads numThreads at the FIRST InferenceSession.create (initializeWebAssembly
// runs once), so changing this requires a full worker re-boot (hard refresh).
const OCR_FORCE_NUM_THREADS = 0;

/**
 * RapidOCR runner: loads ONNX models, runs detection+recognition on ImageBitmap
 */
export class RapidOcrRunner {
  private detSession: InferenceSession | null = null;
  private recSession: InferenceSession | null = null;
  /** The lazily-loaded ort module (loadOrt), set by doInit before any session
   *  create. Methods that use it run only after init() resolved — hence the
   *  non-null assertions matching the existing `this.detSession!` idiom. */
  private ort: OrtWasm | null = null;
  private dictChars: string[] | null = null;
  private dbParams: DBParams;
  /** Injected model origin (S3/HF fetch seam). Must be supplied by the consumer via
   *  createRapidOcrRunner({ modelOrigin }); null ⇒ init() fails loudly (throw-origin)
   *  rather than silently no-op'ing. NOT read from global worker config — see the
   *  import-block note on why this module cannot touch ocr-worker.ts. */
  private modelOrigin: ModelOrigin | null;
  /** Per-engine CTC decoder (owns the one-shot layout log). Built in doInit once the
   *  dict is loaded — the decode logic itself lives in shared/ctc-decode.ts. */
  private ctcDecoder: ReturnType<typeof createCtcDecoder> | null = null;
  /** In-flight init() — dedupes concurrent first calls so we never compile two det/rec
   *  session pairs in parallel (each pair is ~3s of WASM work + ~20MB). */
  private initPromise: Promise<void> | null = null;
  /** Most recent document-level recognition confidence (length-weighted per-box mean). Read
   *  by the OcrRunner adapter to apply the {@link OCR_CONFIDENCE_FLOOR} gate. */
  docConfidence = 0;
  /** True once init() has loaded both sessions + the dict (used by the adapter to label
   *  end-to-end timing cold vs warm). */
  get ready(): boolean {
    return !!(this.detSession && this.recSession && this.dictChars);
  }

  constructor(opts?: {
    dbParams?: Partial<DBParams>,
    modelOrigin?: ModelOrigin,
  }) {
    this.dbParams = { ...DEFAULT_DB_PARAMS, ...opts?.dbParams };
    this.modelOrigin = opts?.modelOrigin ?? null;
    // (ort env configuration moved to doInit — see the env block there. It must
    // be set before the FIRST InferenceSession.create, which ort reads exactly
    // once at initializeWebAssembly; construction-time vs init-time setup is
    // therefore equivalent, and init-time is when the ort module is loaded.)
  }

  /**
   * Load detection model, recognition model, and char dict from HF/IndexedDB
   */
  async init(): Promise<void> {
    if (this.detSession && this.recSession && this.dictChars) return;
    // Dedupe concurrent first calls. Without this, parallel uploads each observe
    // detSession===null before the first resolves and compile a DUPLICATE session pair
    // (~3s + ~20MB each) — the root cause of "every upload pays the warm-up". Every
    // concurrent caller awaits the single in-flight promise.
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null; // allow a retry on failure; later calls hit the guard above
    }
  }

  private async doInit(): Promise<void> {
    console.log("[RapidOcrRunner] init: START"); // ALWAYS LOGGED (not dbg-gated) for production diagnostics

    // Load ort first (lazy — see loadOrt) and configure its env BEFORE any
    // session create. ort reads numThreads/wasmPaths once, at
    // initializeWebAssembly() inside the first InferenceSession.create.
    const ort = (this.ort = await loadOrt());
    // onnxruntime-web loads its WASM glue (ort-wasm-*.mjs/.wasm) via a dynamic
    // import() of `wasmPaths + filename`. Vite only intercepts/transforms
    // *statically-analyzable* import specifiers — a path-relative value like
    // "/ort/" gets inlined and resolved into /public, which Vite refuses to
    // import as a module ("This file is in /public ... should not be imported").
    // Using a full origin URL (runtime value, not statically resolvable) makes
    // Vite leave the dynamic import alone, and the browser fetches the files
    // directly from our own /ort/ (self-hosted — no CDN, no third party).
    // Files copied to /ort/ by scripts/copy-ort-wasm.mjs (public/ort in dev, dist/ort in build).
    ort.env.wasm.wasmPaths = self.location.origin + "/" + "ort/";
    // Multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer/Atomics).
    // Requesting >1 thread WITHOUT it still loads `ort-wasm-simd-threaded` but its
    // kernels compute NaN (the "falling back to single-threading" log does NOT swap
    // the WASM file). Only opt into threads when actually cross-origin-isolated;
    // otherwise force 1 thread so ort uses the correct single-threaded WASM.
    ort.env.wasm.numThreads =
      OCR_FORCE_NUM_THREADS > 0
        ? OCR_FORCE_NUM_THREADS
        : self.crossOriginIsolated
          ? Math.max(1, navigator.hardwareConcurrency - 1)
          : 1;

    // Model origin is INJECTED (createRapidOcrRunner({ modelOrigin })), not read from
    // the worker-shell's global config. See the import-block note: importing the shell
    // here duplicates it across bundles and breaks engine wiring. A missing origin fails
    // loudly via the throw-origin (consistent with liteparse's "inject a real origin"
    // contract) rather than silently no-op'ing.
    const modelOrigin = this.modelOrigin ?? createThrowModelOrigin();

    const detDescriptor: ModelDescriptor = { id: DET_MODEL_ID, version: MODEL_VERSION };
    const recDescriptor: ModelDescriptor = { id: REC_MODEL_ID, version: MODEL_VERSION };
    const dictDescriptor: ModelDescriptor = { id: DICT_MODEL_ID, version: DICT_VERSION };

    console.log("[RapidOcrRunner] init: resolving 3 models (HF fetch on cache miss)…"); // ALWAYS LOGGED
    const t0 = Date.now();
    const [detBytes, recBytes, dictBytes] = await Promise.all([
      resolveModel(detDescriptor, modelOrigin),
      resolveModel(recDescriptor, modelOrigin),
      resolveModel(dictDescriptor, modelOrigin),
    ]);
    console.log( // ALWAYS LOGGED
      `[RapidOcrRunner] init: models resolved in ${Date.now() - t0}ms ` +
      `(det=${detBytes.length}B rec=${recBytes.length}B dict=${dictBytes.length}B)`
    );

    // InferenceSession.create() compiles the WASM backend on first use — this is the
    // most likely hang point if the non-jsep threaded WASM can't initialize its
    // pthread pool without cross-origin isolation. Step-log both sessions so we can
    // see exactly which await never resolves.
    // ── THREADING PROBE ──────────────────────────────────────────────────────
    // The rec timing (895µs/width-unit) matches SINGLE-THREADED WASM, not 7-thread, despite
    // numThreads=7 + crossOriginIsolated + SAB-transferable + no fallback. This probe isolates
    // the missing link: are emscripten's pthread workers actually SPAWNED? ort's threaded WASM
    // creates (numThreads-1) workers via `new Worker(...)`; 0 spawns = the pool never forms →
    // single-threaded despite the config (the smoking gun). Read alongside µs/width-unit.
    const probe: Record<string, unknown> = {
      numThreads_config: ort.env.wasm.numThreads,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: self.crossOriginIsolated,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      wasmPaths: ort.env.wasm.wasmPaths,
    };
    try {
      if (typeof MessageChannel !== "undefined") {
        new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
        probe.sabPostMessage = "ok";
      } else {
        probe.sabPostMessage = "no MessageChannel";
      }
    } catch (e) {
      probe.sabPostMessage = "FAIL: " + (e as Error).message;
    }

    // Wrap self.Worker to count pthread spawns during session.create (emscripten pthreads are
    // JS-spawned via `new Worker(url)` — blob or file URL, the Proxy catches both). Restored after.
    const OrigWorker = (self as unknown as { Worker: typeof Worker }).Worker;
    let pthreadSpawns = 0;
    const pthreadUrls: string[] = [];
    (self as unknown as { Worker: typeof Worker }).Worker = new Proxy(OrigWorker, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      construct(target: any, args: any[]) {
        pthreadSpawns++;
        try {
          const a = args[0];
          pthreadUrls.push(typeof a === "string" ? a.slice(0, 80) : typeof a?.name === "string" ? `Blob:${a.name}` : "<non-string>");
        } catch { pthreadUrls.push("<err>"); }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new (target as any)(...args);
      },
    });

    console.log("[RapidOcrRunner] init: creating det InferenceSession…"); // ALWAYS LOGGED
    const t1 = Date.now();
    this.detSession = await ort.InferenceSession.create(detBytes);
    // initializeWebAssembly() runs inside the FIRST create; on fallback it resets
    // flags.numThreads = 1 HERE. If this reads 1, threading is off — cross-reference the PROBE.
    console.log( // ALWAYS LOGGED
      `[RapidOcrRunner] init: det session created in ${Date.now() - t1}ms (${this.detSession!.inputNames}) ` +
      `| numThreads now: ${ort.env.wasm.numThreads}`
    );

    console.log("[RapidOcrRunner] init: creating rec InferenceSession…"); // ALWAYS LOGGED
    const t2 = Date.now();
    this.recSession = await ort.InferenceSession.create(recBytes);
    console.log(`[RapidOcrRunner] init: rec session created in ${Date.now() - t2}ms (${this.recSession!.inputNames})`); // ALWAYS LOGGED

    // Restore Worker + report pthread spawns. ort inits the WASM runtime (incl. the pthread pool)
    // on the FIRST create, so the spawn count is final by here.
    (self as unknown as { Worker: typeof Worker }).Worker = OrigWorker;
    dbg(
      `[RapidOcrRunner] THREAD PROBE (post-create): pthreadSpawns=${pthreadSpawns} ` +
      `(expected ≈numThreads-1=${ort.env.wasm.numThreads - 1} if the pool formed) ` +
      `sample-urls=${JSON.stringify(pthreadUrls.slice(0, 3))}`
    );

    // Decode char dict from dict.txt: one char per line, UTF-8. The canonical PaddleOCR
    // English dict is 94 chars (printable ASCII: 0-9, :;<=>?@, A-Z, [\]^_`, a-z, {|}~, !"-/).
    // PP-OCR CTC label layout (authoritative — PaddleOCR rec_postprocess.py): blank is
    // PREPENDED at index 0 (`add_special_char` does `['blank'] + dict_character`;
    // `get_ignored_tokens()` returns [0]), and the space char is appended to the dict
    // BEFORE the blank is prepended, so it lands LAST. Final order:
    //   index 0 = blank, indices 1..N = dict[0..N-1], index N+1 = space.
    // With the 94-char dict: numChars = 94 + 1 (blank) + 1 (space) = 96. We store only the
    // raw dict chars; ctcDecode derives the full layout (blank/space positions) from numChars
    // each run and logs the model's actual output dim on first decode to confirm the match.
    const dictText = new TextDecoder().decode(dictBytes);
    this.dictChars = dictText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    this.ctcDecoder = createCtcDecoder(this.dictChars, { debug: DEBUG });

    dbg(
      `[RapidOcrRunner] init: DONE. Det inputs: ${this.detSession!.inputNames}, ` +
      `Rec inputs: ${this.recSession!.inputNames}, Dict chars: ${this.dictChars.length}`
    );
  }

  /**
   * Run detection on an image (ImageBitmap or HTMLCanvasElement)
   * Returns bounding boxes as polygons
   */
  async detect(img: ImageBitmap | HTMLCanvasElement): Promise<TextBox[]> {
    if (!this.detSession) await this.init();

    // Preprocess: resize, normalize, NHWC → NCHW
    const { input, ratioW, ratioH } = await this.preprocessDet(img);

    // Run detection — use the session's actual input name (PP-OCR uses "x" but be safe)
    const detInputName = this.detSession!.inputNames[0]!;
    // Sanity: confirm the input tensor is finite (isolates a NaN-runtime bug from a
    // preprocessing bug). If these are finite but the output is NaN, the WASM runtime
    // is the culprit (e.g. threaded WASM without cross-origin isolation).
    {
      const d = input.data as Float32Array;
      let imn = Infinity;
      let imx = -Infinity;
      for (let i = 0; i < d.length; i++) {
        const v = d[i]!;
        if (v < imn) imn = v;
        if (v > imx) imx = v;
      }
      dbg("[RapidOcrRunner] Det input stats:", { len: d.length, min: imn.toFixed(3), max: imx.toFixed(3) });
    }
    const tDetRun = performance.now();
    const outputs = await this.detSession!.run({ [detInputName]: input });
    const output = outputs[this.detSession!.outputNames[0]!]!; // shape: [1, 1(or 2), H, W]
    const tPost = performance.now();
    dbg("[RapidOcrRunner] Det raw output dims:", output.dims, "ratioW:", ratioW, "ratioH:", ratioH);

    // Post-process: DB algorithm → polygons (per-axis scale ratios map det-map coords
    // back to original-image space INSIDE dbPostProcess).
    const boxes = this.dbPostProcess(output, ratioW, ratioH);
    dbg(
      `[RapidOcrRunner] Detected ${boxes.length} boxes ` +
      `| det timing: run=${(tPost - tDetRun).toFixed(0)}ms dbPostProcess=${(performance.now() - tPost).toFixed(0)}ms`
    );

    // Per-box geometry diagnostic. Points are [TL,TR,BR,BL] (getMiniBoxes order). skewDeg =
    // top-edge angle vs horizontal; aspect = topLen/leftLen (w/h); hOverW = leftLen/topLen.
    // A box with |skewDeg| large or hOverW>=1.5 needs the perspective-warp crop
    // (get_rotate_crop_image) — AABB smears/rotates it into garbage. Correlate this index
    // with the "Recognized … Samples" array (same order) to see if a garbled line maps to a
    // skewed/vertical box (→ fix = warp) vs a normal horizontal box (→ fix = resolution/VLM).
    dbg(
      "[RapidOcrRunner] Box geometry:",
      boxes.map((b, i) => {
        const p = b.points;
        const tl = p[0]!, tr = p[1]!, bl = p[3]!;
        const topLen = Math.hypot(tr[0]! - tl[0]!, tr[1]! - tl[1]!);
        const leftLen = Math.hypot(bl[0]! - tl[0]!, bl[1]! - tl[1]!);
        const skewDeg = (Math.atan2(tr[1]! - tl[1]!, tr[0]! - tl[0]!) * 180) / Math.PI;
        return {
          i,
          skewDeg: +skewDeg.toFixed(1),
          aspect: +(topLen / Math.max(1, leftLen)).toFixed(1),
          hOverW: +(leftLen / Math.max(1, topLen)).toFixed(2),
        };
      })
    );

    return boxes;
  }

  /**
   * Run recognition on a single cropped text box. Returns recognized text + per-box CTC
   * confidence. Also serves as the per-box FALLBACK when a batched rec run fails
   * (recognizeBatched) — a whole-batch session/shape/OOM error is retried one box at a time
   * here so a single degenerate crop can't blank its neighbors.
   */
  async recognizeBox(
    box: TextBox,
    img: ImageBitmap | HTMLCanvasElement
  ): Promise<{ text: string; confidence: number }> {
    if (!this.recSession) await this.init();

    const REC_HEIGHT = 48; // PP-OCRv4 rec fixed input height
    const REC_MAX_WIDTH = 2048;

    // Crop → preprocess into a single channel-major row [3,48,recW] → wrap as a batch-of-1.
    const cropped = await this.cropBox(box, img);
    const cropH = Math.max(1, cropped.height);
    const recW = Math.max(1, Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * cropped.width) / cropH)));
    const data = this.prepareRecRow(cropped, recW);
    cropped.close();

    const input = new this.ort!.Tensor("float32", data, [1, 3, REC_HEIGHT, recW]);
    const recInputName = this.recSession!.inputNames[0]!;
    const outputs = await this.recSession!.run({ [recInputName]: input });
    const output = outputs[this.recSession!.outputNames[0]!]!; // shape: [1, seq_len, num_chars]

    // The rec export's output IS float32 probabilities (the shared decoder's layout probe
    // verifies range [0,1] on the first row) — narrow the ort Tensor union into a TensorLike.
    return this.ctcDecoder!.decodeRow(
      { dims: output.dims, data: output.data as Float32Array },
      0,
    );
  }

  /**
   * Recognition for all detected boxes — SEQUENTIAL per-box inference (not batched).
   *
   * WHY NOT BATCH (the inversion of the usual PaddleOCR/RapidOCR advice, measured here): a
   * same-image A/B (OCR_FORCE_NUM_THREADS @7 vs @1) proved threading is memory-bandwidth-bound in
   * this WASM build — 6 pthreads yield only ~1.4× (det 740→1074ms, rec 1012→1344µs/width-unit).
   * I.e. rec is effectively COMPUTE-bound at ~1.3ms per width-unit, so the only latency lever is
   * FEWER width-units. A batched [G,3,48,maxW] tensor charges EVERY row for the group's widest
   * box: a 120-col box padded into a 1383-col group costs 1383 units (≈11× overcompute), and on
   * the smoke sample batching ADDED ~59% compute (3×1383 padded vs 1383+1100+120 natural). With
   * compute this expensive, the padding cost dominates the saved call count — PaddleOCR batches
   * because on native (8–16× real threads) compute is cheap and padding is negligible; that
   * tradeoff is inverted here. Per-box inference at each box's OWN natural width is faster.
   *
   * Sequential (await in a loop, not Promise.all): onnxruntime-web serializes concurrent
   * single-image runs on one session anyway (they queue, they don't parallelize), so Promise.all
   * buys nothing and adds concurrency overhead — the sequential total equals the sum either way.
   * Per-box error isolation is inherent: each box is its own session.run, so one degenerate crop
   * can only blank itself.
   */
  private async recognizeAll(
    boxes: TextBox[],
    img: ImageBitmap | HTMLCanvasElement
  ): Promise<void> {
    if (boxes.length === 0) return;
    if (!this.recSession) await this.init();

    // Each box: crop → preprocess at its OWN natural width → single session.run → CTC decode.
    // A failed box (degenerate crop / shape error) blanks only itself; the loop continues.
    for (const box of boxes) {
      try {
        const { text, confidence } = await this.recognizeBox(box, img);
        box.text = text;
        box.recConf = confidence;
      } catch (err) {
        box.text = "";
        box.recConf = 0;
        console.error(
          "[RapidOcrRunner] per-box rec FAILED:",
          err instanceof Error ? `${err.message}\n${err.stack}` : err,
        );
      }
    }
  }

  /**
   * Run full detection+recognition on an image. Returns boxes with text filled in.
   * Recognition runs per-box via recognizeAll (sequential, each box at its OWN natural rec width —
   * see recognizeAll for why batching was measured to be a net LOSS in this ~1.4×-threaded WASM
   * regime). Per-box error isolation is inherent.
   */
  async recognize(img: ImageBitmap | HTMLCanvasElement): Promise<TextBox[]> {
    const boxes = await this.detect(img);

    // Pre-recognition geometry filter (#2): drop boxes too small to hold legible text BEFORE
    // paying for recognition. A sub-MIN_BOX_SIDE_PX box is detection noise (a texture edge, a
    // hairline) — recognizing it costs a full rec inference and only ever yields garbage/empty.
    // See MIN_BOX_SIDE_PX for the reasoning + the conservative threshold.
    const recBoxes = boxes.filter((b) => minBoxSide(b) >= MIN_BOX_SIDE_PX);
    const droppedGeo = boxes.length - recBoxes.length;

    const tRec = performance.now();
    await this.recognizeAll(recBoxes, img);
    dbg(
      `[RapidOcrRunner] rec timing: ${recBoxes.length} boxes in ${(performance.now() - tRec).toFixed(0)}ms` +
      (droppedGeo > 0 ? ` (detected ${boxes.length}, dropped ${droppedGeo} sub-${MIN_BOX_SIDE_PX}px pre-rec)` : "")
    );

    // Per-box confidence filter (#1): drop boxes the rec model read POORLY — an unsupported
    // script (Arabic via a Latin model), detection noise, a degenerate crop — from BOTH the
    // output text and the doc-confidence mean. See PER_BOX_CONFIDENCE_FLOOR for the reasoning:
    // such a box is garbage and must not appear in the text NOR drag the doc mean toward the
    // escalation floor (which would discard the doc's GOOD text alongside it — the bug where a
    // bilingual form's unreadable Arabic nuked ~2450 chars of perfect English). The doc-level
    // OCR_CONFIDENCE_FLOOR gate (applied by the adapter below) remains the backstop for a doc
    // that is SYSTEMICALLY medium-confidence (every box unsure → survivors still average < floor
    // → escalate).
    const kept = recBoxes.filter((b) => (b.recConf ?? 0) >= PER_BOX_CONFIDENCE_FLOOR);
    const droppedLowConf = recBoxes.length - kept.length;

    // Document-level confidence: length-weighted mean over the KEPT (confident) boxes only.
    this.docConfidence = lengthWeightedConfidence(kept);

    const recognized = recBoxes.filter((b) => b.text && b.text.trim().length > 0);
    dbg(
      `[RapidOcrRunner] Recognized ${recognized.length}/${recBoxes.length} boxes, ` +
      `${kept.length} passed per-box conf filter (≥${PER_BOX_CONFIDENCE_FLOOR}` +
      (droppedLowConf > 0 ? `, dropped ${droppedLowConf} garbage` : "") + `). ` +
      `Doc confidence: ${this.docConfidence.toFixed(3)} (floor ${OCR_CONFIDENCE_FLOOR}).`
    );
    // Per-box breakdown (ALL recognized boxes; filtered-out boxes marked ✗ so the filter
    // boundary is visible when diagnosing why a box was kept/dropped), as a flat string (not a
    // collapsible object) so it stays readable when pasted back. Index-aligned with the
    // Box-geometry log for cross-referencing a low-confidence box against its skew/aspect.
    dbg(
      recBoxes
        .map((b, i) => {
          const len = (b.text || "").replace(/\s/g, "").length;
          const mark = (b.recConf ?? 0) >= PER_BOX_CONFIDENCE_FLOOR ? " " : "✗";
          return ` ${mark}[${i}] conf=${(b.recConf ?? 0).toFixed(3)} len=${len} ${JSON.stringify((b.text || "").slice(0, 42))}`;
        })
        .join("\n")
    );

    return kept;
  }

  /**
   * Preprocess image for detection
   * - Resize keeping aspect ratio (max dimension ≤ 960, multiple of 32)
   * - Normalize with ImageNet mean/std (PP-OCRv4 det standard)
   * - Convert NHWC → NCHW
   *
   * Returns per-axis scale ratios (ratioW = srcW / resizedW, ratioH = srcH / resizedH)
   * computed from the ROUNDED-to-32 resized dims. dbPostProcess uses these to map
   * det-map coordinates back to original-image space.
   */
  private async preprocessDet(
    img: ImageBitmap | HTMLCanvasElement
  ): Promise<{ input: Tensor; ratioW: number; ratioH: number }> {
    // Calibrated in ocr-lab: 960/832/736/640 all detect identical boxes + equivalent text on
    // the sample flyer (rawMax flat ~0.98). Lower DET_MAX_SIDE = smaller det input AND a smaller
    // probability map → faster det run AND faster dbPostProcess (it scans every prob-map pixel).
    // 736 nearly halves the prob-map area (−44%) with a wider small-text safety margin than 640.
    // Re-run the lab on a denser/low-contrast sample before dropping below 736 — the failure
    // mode of too low a value is silently dropping fine text boxes, invisible on easy samples.
    const DET_MAX_SIDE = 736;

    const srcW = img instanceof ImageBitmap ? img.width : img.width;
    const srcH = img instanceof ImageBitmap ? img.height : img.height;

    // Resize keeping aspect ratio, max side ≤ DET_MAX_SIDE
    const ratio = Math.min(DET_MAX_SIDE / srcW, DET_MAX_SIDE / srcH);
    let resizedW = Math.round(srcW * ratio);
    let resizedH = Math.round(srcH * ratio);

    // Round to nearest multiple of 32 (required by the det model)
    resizedW = Math.max(32, Math.round(resizedW / 32) * 32);
    resizedH = Math.max(32, Math.round(resizedH / 32) * 32);

    // Per-axis scale ratios from the ROUNDED resized dims (NOT the raw ratio, which
    // diverges after the round-to-32 step). original = det-map-coord * ratio.
    const ratioW = srcW / resizedW;
    const ratioH = srcH / resizedH;

    const canvas = new OffscreenCanvas(resizedW, resizedH);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, resizedW, resizedH);

    const imageData = ctx.getImageData(0, 0, resizedW, resizedH);
    const pixels = imageData.data;

    // Normalize: ImageNet mean/std (PP-OCRv4 det standard)
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const pixelCount = resizedW * resizedH;
    const data = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      for (let c = 0; c < 3; c++) {
        const pixel = pixels[i * 4 + c]! / 255.0; // to [0,1]
        data[c * pixelCount + i] = (pixel - mean[c]!) / std[c]!;
      }
    }

    const input = new this.ort!.Tensor("float32", data, [1, 3, resizedH, resizedW]);

    return { input, ratioW, ratioH };
  }

  /**
   * Preprocess one cropped text box into a recognition input ROW: channel-major [3,48,targetW]
   * (no batch dim — the caller stacks rows into a [G,3,48,targetW] tensor for batched inference,
   * or wraps a single row as a batch-of-1).
   *
   * PP-OCRv4 rec expects a FIXED height of 48. The crop is drawn into the LEFT recW columns at
   * its aspect-preserving width (recW = round(48·cropW/cropH), capped), and the remaining
   * [recW, targetW) columns are left WHITE (normalized +1) — an empty document margin the rec
   * model maps to CTC blank. For a single-box call pass targetW = recW (no padding). mean/std =
   * 0.5/0.5 → [-1,1]. BGR feed (canvas RGBA → rec plane 0←B,1←G,2←R), matching PaddleOCR.
   *
   * Right-padding is CTC-safe: the padded columns are TRAILING, emit only blank, and the decoder
   * averages confidence over EMITTED timesteps only — so padding contributes neither characters
   * nor spurious low-confidence terms. Width-sorting in recognizeBatched groups similar-width
   * boxes so each batch pads to its own max (minimal waste).
   *
   * The white pad (not black) matters: a transparent/black canvas would normalize to -1 (black
   * ink), which the model — trained on white-background documents — can misread as strokes →
   * stray characters. White (+1) reads as a blank margin → CTC blank → correctly empty.
   */
  private prepareRecRow(cropped: ImageBitmap, targetW: number): Float32Array {
    const REC_HEIGHT = 48; // PP-OCRv4 rec fixed input height
    const REC_MAX_WIDTH = 2048;

    const cropW = cropped.width;
    const cropH = Math.max(1, cropped.height);
    const recW = Math.max(1, Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * cropW) / cropH)));

    const canvas = new OffscreenCanvas(targetW, REC_HEIGHT);
    const ctx = canvas.getContext("2d")!;
    // White fill → right-padding region (cols ≥ recW) normalizes to +1 (white margin → CTC
    // blank). See the method doc for why white, not black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, REC_HEIGHT);
    // High-quality smoothing: when the crop is taller than 48px (a downscale), the default
    // "low" quality aliases and collapses narrow strokes (i, l, v, doubled letters) — the
    // "need"→"nd", "minimum"→"mnum", "level"→"leel" signature. PaddleOCR/RapidOCR use cv2
    // INTER_LINEAR (area-aware); "high" is the canvas equivalent. (No effect on upscaling.)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cropped, 0, 0, cropW, cropH, 0, 0, recW, REC_HEIGHT);

    const imageData = ctx.getImageData(0, 0, targetW, REC_HEIGHT);
    const pixels = imageData.data;

    // PaddleOCR/RapidOCR feed BGR end-to-end (cv2, no cvtColor). Canvas gives RGBA, so map
    // rec plane 0←Blue, 1←Green, 2←Red. On grayscale text R=G=B (no-op), but on COLORED
    // text/backgrounds an RGB feed swaps the model's first-conv R/B weights → wrong
    // activations (a real contributor to errors on this colored flyer).
    const pixelCount = REC_HEIGHT * targetW;
    const data = new Float32Array(3 * pixelCount);
    const bgrIndex = [2, 1, 0]; // rec plane c ← canvas channel (B, G, R)
    for (let i = 0; i < pixelCount; i++) {
      for (let c = 0; c < 3; c++) {
        const pixel = pixels[i * 4 + bgrIndex[c]!]! / 255.0;
        data[c * pixelCount + i] = (pixel - 0.5) / 0.5;
      }
    }
    return data;
  }

  /**
   * DB (Differentiable Binarization) post-processing
   * Converts probability map to text polygons
   *
   * Delegates to the db-postprocess module which implements the full DB algorithm.
   * Per-axis scale ratios (ratioW, ratioH) are forwarded to the module, which scales
   * box coordinates from det-map (resized-image) space back to original-image space
   * INSIDE — the runner no longer post-multiplies.
   */
  private dbPostProcess(detOutput: Tensor, ratioW: number, ratioH: number): TextBox[] {
    const [batch, channels, height, width] = detOutput.dims as [number, number, number, number];

    // detOutput is [1, 2, H, W] where channel 0 is probability, channel 1 is threshold map.
    // NOTE: use the synchronous `.data` getter, NOT `getData()`. In onnxruntime-web 1.27+
    // `getData()` is async (returns a Promise<TensorDataType> to support GPU→CPU download);
    // calling it without `await` and casting with `as Float32Array` silently yields a Promise,
    // whose indices are `undefined` — which db-postprocess's comparison-based stats then
    // misread as an all-NaN prob map (min=Infinity, max=-Infinity, mean=NaN). The WASM EP we
    // use always places output data on the CPU, so `.data` is safe and synchronous here.
    const data = detOutput.data as Float32Array;

    // Run DB post-processing. The module scales coordinates to original-image space using
    // ratioW/ratioH, so we return its boxes directly (no post-multiply here). The module
    // returns { points, score } which is structurally compatible with the runner's TextBox
    // (text? stays undefined at this stage — filled later by recognizeBox).
    const boxes = dbPostProcess(data, [batch, channels, height, width], this.dbParams, ratioW, ratioH);

    return boxes;
  }

  /**
   * Crop a bounding box from the original image
   */
  private async cropBox(
    box: TextBox,
    img: ImageBitmap | HTMLCanvasElement
  ): Promise<ImageBitmap> {
    // Find bounding box of the polygon
    const xs = box.points.map((p) => p[0]!);
    const ys = box.points.map((p) => p[1]!);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    const width = maxX - minX;
    const height = maxY - minY;

    // Create canvas and crop
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(
      img,
      minX,
      minY,
      width,
      height,
      0,
      0,
      width,
      height
    );

    return canvas.transferToImageBitmap();
  }

  /**
   * Release model sessions
   */
  dispose(): void {
    void this.detSession?.release();
    void this.recSession?.release();
    this.detSession = null;
    this.recSession = null;
  }
}

/**
 * Create an OcrRunner from the RapidOCR implementation
 * Adapts RapidOcrRunner to liteparse's OcrRunner contract
 */
export function createRapidOcrRunner(opts?: {
  dbParams?: Partial<DBParams>,
  /**
   * Model origin (S3/HF fetch seam) for the det/rec/dict weights. REQUIRED for OCR to
   * work — pass the SAME origin you give `configureWorker({ modelOrigin })`. This is
   * injected rather than read from the worker shell because importing the shell into
   * this subpath bundle duplicates it (two shell instances → broken engine wiring).
   */
  modelOrigin?: ModelOrigin,
  /** Kick off model fetch + WASM session compile at construction instead of lazily on the
   *  first parse. init() is idempotent (singleton guard + in-flight promise), so the first
   *  recognize() either short-circuits (done) or awaits the same in-flight promise. Errors
   *  are swallowed (they resurface on the first real parse). */
  eagerInit?: boolean,
  /** Emit OCR telemetry (init timing, det/rec stats, box geometry, CTC layout). Default true.
   *  Pass `false` (or `import.meta.env.DEV`) to silence in production. */
  debug?: boolean,
}): OcrRunner {
  DEBUG = opts?.debug ?? true;
  // Mirror the runner's debug flag into dbPostProcess so the same option silences
  // the det-prob-map stats too — one knob controls every diagnostic in the pipeline.
  setDbPostProcessDebug(DEBUG);
  const runner = new RapidOcrRunner(opts);

  // Eager warm-up: compile the det/rec sessions while the user is still composing their
  // message, not on their first document upload. The ~3s first-init cost is hidden behind
  // idle time. Worker boots at chat-panel mount (warmupOcrWorker), so this fires early.
  if (opts?.eagerInit) {
    runner.init().catch((err) => {
      console.warn("[RapidOcrRunner] eager warm-up failed (will retry on first parse):", err);
    });
  }

  return {
    async recognize(image, ctx) {
      if (ctx.signal?.aborted) throw new Error("aborted");

      const tTotal = performance.now();
      const initCold = !runner.ready;
      await runner.init();

      // Convert Uint8Array (PNG) to ImageBitmap. Cast: TS 5.7+ widened Uint8Array to
      // Uint8Array<ArrayBufferLike>, which is no longer directly assignable to BlobPart.
      // The runtime accepts a Uint8Array view fine.
      const blob = new Blob([image as BlobPart], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);

      // Run full recognition (sets runner.docConfidence — the length-weighted per-box mean)
      const boxes = await runner.recognize(bitmap);

      // Order boxes into reading order before joining, so the text the agent receives reads
      // top-to-bottom, left-to-right. Detection returns boxes in SCORE order, which scrambles
      // the line sequence (e.g. a bullet point outscores the title and prints first). Boxes on
      // the same visual line have near-equal top edges (grouped by the 5px tolerance); distinct
      // text lines are tens of px apart, so the tolerance cleanly separates them.
      const readingOrder = readingOrderSort(boxes);
      const text = readingOrder.map((b) => b.text || "").join("\n");
      const conf = runner.docConfidence;
      dbg(
        `[RapidOcrRunner] end-to-end ${(performance.now() - tTotal).toFixed(0)}ms ` +
        `(init ${initCold ? "cold — compiled this turn" : "warm — cached"}).`
      );

      // ── Confidence gate (garbage indicator → VLM fallback) ──────────────────────
      // If the doc-level recognition confidence is below the floor AND we actually produced
      // text, DISCARD it (return ""). The liteparse cascade then sees an under-yield (text
      // < usableFloor); rapidocr is the only browser strategy for images, so executeRoute
      // returns an empty document → clientExtract's isUsable() fails → the parse-document
      // edge function (VLM) re-reads the document. VLM handles stylized/colored/low-contrast
      // content far better than a CTC rec model. This is the same pattern liteparse's own
      // Granite engine uses internally (low-confidence → {text:""} → cascade descends). The
      // text-non-empty guard avoids a misleading "discarded" log on a genuine no-text result
      // (which under-yields naturally either way).
      if (text.trim().length > 0 && conf < OCR_CONFIDENCE_FLOOR) {
        dbg(
          `[RapidOcrRunner] Confidence gate TRIPPED: doc conf ${conf.toFixed(3)} < floor ${OCR_CONFIDENCE_FLOOR} ` +
          `(risk ${((1 - conf) * 100).toFixed(1)}% > ${((1 - OCR_CONFIDENCE_FLOOR) * 100).toFixed(0)}%) — ` +
          `discarding ${text.length} chars of OCR text, escalating to edge VLM via under-yield.`
        );
        return { text: "", confidence: conf };
      }

      dbg(
        "[RapidOcrRunner] Final OCR text length:", text.length,
        "conf:", conf.toFixed(3)
      );
      return { text, confidence: conf };
    },

    dispose() {
      runner.dispose();
    },
  };
}
