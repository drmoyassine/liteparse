import type { OcrContext, OcrEngine, OcrResult } from "../types.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  dbPostProcess,
  DEFAULT_DB_PARAMS,
  setDbPostProcessDebug,
  type DBParams,
} from "../engines/rapidocr/db-postprocess.js";
import { createCtcDecoder } from "../engines/rapidocr/shared/ctc-decode.js";
import { readingOrderSort } from "../engines/rapidocr/shared/reading-order.js";
import {
  lengthWeightedConfidence,
  minBoxSide,
  OCR_CONFIDENCE_FLOOR,
  PER_BOX_CONFIDENCE_FLOOR,
  MIN_BOX_SIDE_PX,
  type TextBox,
} from "../engines/rapidocr/shared/quality.js";

/**
 * Node OCR engine running the SAME PP-OCRv4 det+rec models as the browser Web Worker,
 * via onnxruntime-node. This is the OCR half of browser-runtime parity for the
 * self-hosted parse runner: identical preprocessing, identical DB post-processing,
 * identical CTC decoding and identical quality gates — everything runtime-agnostic
 * lives in ../engines/rapidocr/shared/ and is imported, not duplicated.
 *
 * Pipeline per image (all ported verbatim from the browser runner, which was
 * calibrated in scripts/ocr-lab):
 *   decode → det preprocess (max side 736, round-32, ImageNet mean/std, NCHW)
 *   → det session → dbPostProcess (scales boxes back to original-image space)
 *   → min-box geometry filter → per-box AABB crop → rec preprocess
 *   (h=48, aspect width, WHITE right-pad, BGR, /0.5) → rec session → CTC decode
 *   → per-box confidence filter → length-weighted doc confidence
 *   → doc confidence gate (discard → cascade escalates to VLM)
 *   → reading-order join.
 *
 * Requires optional native packages (loaded via dynamic import inside the factory,
 * so importing this subpath never crashes a runtime that lacks them):
 *   - `onnxruntime-node` — native ONNX inference
 *   - `@napi-rs/canvas` — image decode + 2D canvas for preprocess/crop
 *
 * Usage:
 *   import { createRapidOcrServerEngine } from "liteparse/ocr/rapidocr-server";
 *   const engine = await createRapidOcrServerEngine();
 *   const { text } = await engine.recognize(pngBytes, { pageIndex: 0, totalPages: 1 });
 *
 * Model paths are auto-detected in order:
 *   1. `opts.modelPath` — explicit model directory
 *   2. `process.env.RAPIDOCR_MODEL_PATH` — explicit model directory
 *   3. `./models/rapidocr` — relative to the process cwd
 *   4. `node_modules/rapidocr-models/models` — models installed as sibling package
 */

// The engine emits OCR-quality/latency telemetry (init timing, det/rec stats, box
// counts, CTC layout). Same convention as the browser runner: diagnostics ON by
// default so any deployment sees them out of the box; pass `debug: false` for
// prod-quiet. Real error paths stay on console.error/warn unconditionally.
let DEBUG = true;
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Optional natives — typed as `any` (same pattern as raster/sharp.ts): the packages
// are peer-optional, loaded dynamically, and never part of the core bundle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CanvasImage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Canvas2D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Canvas = any;

interface ServerModel {
  ort: OrtModule;
  det: OrtSession;
  rec: OrtSession;
  /** Rec dictionary lines (CTC labels 1..N; blank@0, space LAST — see shared/ctc-decode). */
  dict: string[];
  /** Per-engine CTC decoder (owns the one-shot layout log). */
  ctcDecoder: ReturnType<typeof createCtcDecoder>;
  /** @napi-rs/canvas helpers, loaded once with the models. */
  loadImage: (src: Uint8Array) => Promise<CanvasImage>;
  createCanvas: (w: number, h: number) => Canvas;
}

let singletonModel: ServerModel | null = null;
let singletonPromise: Promise<ServerModel> | null = null;

export interface RapidOcrServerOptions {
  /** Explicit path to RapidOCR ONNX model directory (overrides auto-detection) */
  modelPath?: string;
  /** Detection model filename (default: "ch_PP-OCRv4_det.onnx" — PP-OCRv4, Latin-capable) */
  detModel?: string;
  /** Recognition model filename (default: "en_PP-OCRv4_rec_infer.onnx" — PP-OCRv4 English) */
  recModel?: string;
  /** Dictionary file for recognition (default: "ppocr-en-dict.txt") */
  dictFile?: string;
  /** DB post-processing thresholds (defaults: DEFAULT_DB_PARAMS). */
  dbParams?: Partial<DBParams>;
  /** Emit OCR telemetry (default true). */
  debug?: boolean;
}

/** A RapidOCR server engine with an extra `dispose()` to release the ONNX sessions. */
export type RapidOcrServerEngine = OcrEngine & { dispose(): void };

/**
 * Create a RapidOCR server engine with auto-detected or explicit model paths.
 * The first call initializes the singleton model (sessions + dict + canvas); subsequent
 * calls return an engine over the cached instance. Warm the singleton at process start
 * (the parse runner does) so the first request doesn't pay model-load latency.
 */
export async function createRapidOcrServerEngine(
  opts: RapidOcrServerOptions = {},
): Promise<RapidOcrServerEngine> {
  DEBUG = opts.debug ?? true;
  setDbPostProcessDebug(DEBUG);

  if (singletonModel) {
    return createEngine(singletonModel, opts);
  }
  if (singletonPromise) {
    return createEngine(await singletonPromise, opts);
  }
  singletonPromise = loadServerModel(opts);
  try {
    singletonModel = await singletonPromise;
    return createEngine(singletonModel, opts);
  } catch (err) {
    singletonPromise = null;
    throw err;
  }
}

function createEngine(model: ServerModel, opts: RapidOcrServerOptions): RapidOcrServerEngine {
  const dbParams: DBParams = { ...DEFAULT_DB_PARAMS, ...opts.dbParams };
  return {
    name: "rapidocr-server",
    available: true,

    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      if (ctx.signal?.aborted) throw new Error("aborted");
      const tTotal = performance.now();

      // Decode the rastered page (PNG/JPEG bytes) via @napi-rs/canvas (skia).
      const img = await model.loadImage(
        Buffer.from(image.buffer, image.byteOffset, image.byteLength),
      );

      // Full det+rec with the shared gates (sets docConfidence).
      const { kept, docConfidence } = await recognizeImage(model, img, dbParams, ctx.signal);

      // Reading order before joining — detection returns score order, which scrambles lines.
      const text = readingOrderSort(kept)
        .map((b) => b.text || "")
        .join("\n");

      dbg(
        `[rapidocr-server] end-to-end ${(performance.now() - tTotal).toFixed(0)}ms: ` +
          `${text.length} chars, doc conf ${docConfidence.toFixed(3)}.`
      );

      // Confidence gate (garbage indicator → VLM fallback) — same contract as the browser
      // runner: below the floor, DISCARD the text so the liteparse cascade under-yields and
      // the route descends to the VLM. The text-non-empty guard avoids a misleading
      // "discarded" log on a genuine no-text result.
      if (text.trim().length > 0 && docConfidence < OCR_CONFIDENCE_FLOOR) {
        dbg(
          `[rapidocr-server] Confidence gate TRIPPED: doc conf ${docConfidence.toFixed(3)} < ` +
            `floor ${OCR_CONFIDENCE_FLOOR} — discarding ${text.length} chars, escalating via under-yield.`
        );
        return { text: "", confidence: docConfidence };
      }

      return { text, confidence: docConfidence };
    },

    dispose() {
      void model.det?.release();
      void model.rec?.release();
      if (singletonModel === model) {
        singletonModel = null;
        singletonPromise = null;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recognition pipeline (ported verbatim from the browser runner — see
// engines/rapidocr/rapidocr-onnx-runner.ts for the full calibration notes)
// ─────────────────────────────────────────────────────────────────────────────

/** Det input sizing, calibrated in ocr-lab (identical boxes/text at 736 vs 960, −44% prob-map area). */
const DET_MAX_SIDE = 736;
/** PP-OCRv4 rec fixed input height. */
const REC_HEIGHT = 48;
/** Rec input width cap. */
const REC_MAX_WIDTH = 2048;

async function recognizeImage(
  model: ServerModel,
  img: CanvasImage,
  dbParams: DBParams,
  signal?: AbortSignal,
): Promise<{ kept: TextBox[]; docConfidence: number }> {
  const boxes = await detect(model, img, dbParams);

  // Pre-recognition geometry filter: drop boxes too small to hold legible text BEFORE paying
  // for recognition (see shared/quality MIN_BOX_SIDE_PX).
  const recBoxes = boxes.filter((b) => minBoxSide(b) >= MIN_BOX_SIDE_PX);
  const droppedGeo = boxes.length - recBoxes.length;

  const tRec = performance.now();
  let recCount = 0;
  for (const box of recBoxes) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const { text, confidence } = await recognizeBox(model, box, img);
      box.text = text;
      box.recConf = confidence;
      recCount++;
    } catch (err) {
      // Per-box error isolation: a degenerate crop blanks only itself; the loop continues.
      box.text = "";
      box.recConf = 0;
      console.error("[rapidocr-server] per-box rec FAILED:", err instanceof Error ? err.message : err);
    }
  }
  dbg(
    `[rapidocr-server] rec timing: ${recCount}/${recBoxes.length} boxes in ` +
      `${(performance.now() - tRec).toFixed(0)}ms` +
      (droppedGeo > 0 ? ` (detected ${boxes.length}, dropped ${droppedGeo} sub-${MIN_BOX_SIDE_PX}px pre-rec)` : "")
  );

  // Per-box confidence filter: drop boxes the rec model read POORLY from BOTH the output
  // text and the doc-confidence mean (see shared/quality PER_BOX_CONFIDENCE_FLOOR).
  const kept = recBoxes.filter((b) => (b.recConf ?? 0) >= PER_BOX_CONFIDENCE_FLOOR);
  const droppedLowConf = recBoxes.length - kept.length;

  const docConfidence = lengthWeightedConfidence(kept);
  dbg(
    `[rapidocr-server] Recognized ${recBoxes.filter((b) => b.text && b.text.trim()).length}/${recBoxes.length} ` +
      `boxes, ${kept.length} passed per-box conf filter (≥${PER_BOX_CONFIDENCE_FLOOR}` +
      (droppedLowConf > 0 ? `, dropped ${droppedLowConf} garbage` : "") + `). ` +
      `Doc confidence: ${docConfidence.toFixed(3)} (floor ${OCR_CONFIDENCE_FLOOR}).`
  );
  dbg(
    recBoxes
      .map((b, i) => {
        const len = (b.text || "").replace(/\s/g, "").length;
        const mark = (b.recConf ?? 0) >= PER_BOX_CONFIDENCE_FLOOR ? " " : "✗";
        return ` ${mark}[${i}] conf=${(b.recConf ?? 0).toFixed(3)} len=${len} ${JSON.stringify((b.text || "").slice(0, 42))}`;
      })
      .join("\n")
  );

  return { kept, docConfidence };
}

async function detect(model: ServerModel, img: CanvasImage, dbParams: DBParams): Promise<TextBox[]> {
  const { data, dims, ratioW, ratioH } = preprocessDet(model, img);

  // Sanity: confirm the det input is finite (isolates a NaN-runtime bug from a
  // preprocessing bug). If finite in but NaN out, the runtime is the culprit.
  {
    let imn = Infinity;
    let imx = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      if (v < imn) imn = v;
      if (v > imx) imx = v;
    }
    dbg(`[rapidocr-server] Det input stats: len=${data.length} min=${imn.toFixed(3)} max=${imx.toFixed(3)}`);
  }

  const input = new model.ort.Tensor("float32", data, dims);
  const tDetRun = performance.now();
  const detInputName = model.det.inputNames[0] as string;
  const outputs = (await model.det.run({ [detInputName]: input })) as Record<string, { dims: number[]; data: Float32Array }>;
  const output = outputs[model.det.outputNames[0] as string]!; // shape: [1, 1|2, H, W]
  const tPost = performance.now();

  const [batch, channels, height, width] = output.dims as [number, number, number, number];
  // `.data` is synchronous on onnxruntime-node (CPU tensors) — no async getData() dance
  // needed here (that gotcha is onnxruntime-web 1.27+ specific).
  const boxes = dbPostProcess(output.data, [batch, channels, height, width], dbParams, ratioW, ratioH);
  dbg(
    `[rapidocr-server] Detected ${boxes.length} boxes | det timing: run=${(tPost - tDetRun).toFixed(0)}ms ` +
      `dbPostProcess=${(performance.now() - tPost).toFixed(0)}ms (ratioW=${ratioW.toFixed(3)} ratioH=${ratioH.toFixed(3)})`
  );
  return boxes;
}

/**
 * Det preprocess: resize keeping aspect (max side 736), round to /32 (model requirement),
 * ImageNet mean/std normalize, NHWC → NCHW. Ratios map det-map coords back to original
 * space and are computed from the ROUNDED dims (dbPostProcess consumes them).
 */
/** Det preprocess result: the raw float payload (the caller wraps it in an ort.Tensor). */
function preprocessDet(
  model: ServerModel,
  img: CanvasImage,
): { data: Float32Array; dims: number[]; ratioW: number; ratioH: number } {
  const srcW = img.width as number;
  const srcH = img.height as number;

  const ratio = Math.min(DET_MAX_SIDE / srcW, DET_MAX_SIDE / srcH);
  const resizedW = Math.max(32, Math.round((srcW * ratio) / 32) * 32);
  const resizedH = Math.max(32, Math.round((srcH * ratio) / 32) * 32);

  const ratioW = srcW / resizedW;
  const ratioH = srcH / resizedH;

  const canvas = model.createCanvas(resizedW, resizedH);
  const ctx = canvas.getContext("2d") as Canvas2D;
  ctx.drawImage(img, 0, 0, resizedW, resizedH);
  const pixels = (ctx.getImageData(0, 0, resizedW, resizedH) as { data: Uint8ClampedArray }).data;

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const pixelCount = resizedW * resizedH;
  const data = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const pixel = pixels[i * 4 + c]! / 255.0;
      data[c * pixelCount + i] = (pixel - mean[c]!) / std[c]!;
    }
  }

  return { data, dims: [1, 3, resizedH, resizedW], ratioW, ratioH };
}

/** AABB-crop a detected box from the page image onto its own canvas. */
function cropBox(model: ServerModel, box: TextBox, img: CanvasImage): Canvas {
  const xs = box.points.map((p) => p[0]!);
  const ys = box.points.map((p) => p[1]!);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(1, Math.round(Math.max(...xs) - minX));
  const height = Math.max(1, Math.round(Math.max(...ys) - minY));

  const canvas = model.createCanvas(width, height);
  const ctx = canvas.getContext("2d") as Canvas2D;
  ctx.drawImage(img, minX, minY, width, height, 0, 0, width, height);
  return canvas;
}

/**
 * Rec preprocess: draw the crop at aspect-preserving width into a REC_HEIGHT-tall row,
 * WHITE right-pad to targetW, BGR plane order, /0.5 → [-1,1]. White (not black) padding
 * reads as a document margin → CTC blank; black would normalize to "ink". High-quality
 * smoothing avoids collapsing narrow strokes on downscale ("minimum"→"mnum").
 */
function prepareRecRow(model: ServerModel, cropped: Canvas, targetW: number): Float32Array {
  const cropW = cropped.width as number;
  const cropH = Math.max(1, cropped.height as number);
  const recW = Math.max(1, Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * cropW) / cropH)));

  const canvas = model.createCanvas(targetW, REC_HEIGHT);
  const ctx = canvas.getContext("2d") as Canvas2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetW, REC_HEIGHT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cropped, 0, 0, cropW, cropH, 0, 0, recW, REC_HEIGHT);

  const pixels = (ctx.getImageData(0, 0, targetW, REC_HEIGHT) as { data: Uint8ClampedArray }).data;
  const pixelCount = REC_HEIGHT * targetW;
  const data = new Float32Array(3 * pixelCount);
  const bgrIndex = [2, 1, 0]; // rec plane c ← canvas channel (B, G, R) — PaddleOCR feeds BGR
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const pixel = pixels[i * 4 + bgrIndex[c]!]! / 255.0;
      data[c * pixelCount + i] = (pixel - 0.5) / 0.5;
    }
  }
  return data;
}

/** Recognize one box: crop → rec row at its OWN natural width (no batching — see browser
 * runner's recognizeAll for the measured rationale) → single session.run → CTC decode. */
async function recognizeBox(
  model: ServerModel,
  box: TextBox,
  img: CanvasImage,
): Promise<{ text: string; confidence: number }> {
  const cropped = cropBox(model, box, img);
  const cropH = Math.max(1, cropped.height as number);
  const recW = Math.max(1, Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * (cropped.width as number)) / cropH)));
  const data = prepareRecRow(model, cropped, recW);

  const input = new model.ort.Tensor("float32", data, [1, 3, REC_HEIGHT, recW]);
  const recInputName = model.rec.inputNames[0] as string;
  const outputs = (await model.rec.run({ [recInputName]: input })) as Record<
    string,
    { dims: number[]; data: Float32Array }
  >;
  const output = outputs[model.rec.outputNames[0] as string]!; // shape: [1, seq_len, num_chars]

  return model.ctcDecoder.decodeRow({ dims: output.dims, data: output.data }, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Model loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadServerModel(opts: RapidOcrServerOptions): Promise<ServerModel> {
  const tInit = performance.now();

  let ort: OrtModule;
  let canvasMod: { loadImage?: unknown; createCanvas?: unknown };
  try {
    [ort, canvasMod] = await Promise.all([import("onnxruntime-node"), import("@napi-rs/canvas")]);
  } catch {
    throw new Error(
      "rapidocr-server requires onnxruntime-node and @napi-rs/canvas. " +
        "Install both: npm install onnxruntime-node @napi-rs/canvas",
    );
  }
  const loadImage = canvasMod.loadImage as ((src: Uint8Array) => Promise<CanvasImage>) | undefined;
  const createCanvas = canvasMod.createCanvas as ((w: number, h: number) => Canvas) | undefined;
  if (typeof loadImage !== "function" || typeof createCanvas !== "function") {
    throw new Error("@napi-rs/canvas did not expose loadImage/createCanvas");
  }

  const modelPath = await detectModelPath(opts.modelPath);
  if (!modelPath) {
    throw new Error(
      "RapidOCR models not found. Set RAPIDOCR_MODEL_PATH env var or place models in ./models/rapidocr " +
        "(expected: ch_PP-OCRv4_det.onnx, en_PP-OCRv4_rec_infer.onnx, ppocr-en-dict.txt)",
    );
  }

  const detPath = resolve(modelPath, opts.detModel ?? "ch_PP-OCRv4_det.onnx");
  const recPath = resolve(modelPath, opts.recModel ?? "en_PP-OCRv4_rec_infer.onnx");
  const dictPath = resolve(modelPath, opts.dictFile ?? "ppocr-en-dict.txt");

  if (!existsSync(detPath)) throw new Error(`Detection model not found: ${detPath}`);
  if (!existsSync(recPath)) throw new Error(`Recognition model not found: ${recPath}`);
  if (!existsSync(dictPath)) throw new Error(`Dictionary file not found: ${dictPath}`);

  const [det, rec, dict] = await Promise.all([
    ort.InferenceSession.create(detPath, { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(recPath, { executionProviders: ["cpu"] }),
    loadDict(dictPath),
  ]);
  const ctcDecoder = createCtcDecoder(dict, { debug: DEBUG });

  dbg(`[rapidocr-server] init ${(performance.now() - tInit).toFixed(0)}ms (${detPath})`);
  return { ort, det, rec, dict, ctcDecoder, loadImage, createCanvas };
}

async function detectModelPath(explicitPath?: string): Promise<string | null> {
  if (explicitPath) {
    return explicitPath;
  }

  const envPath = process.env.RAPIDOCR_MODEL_PATH;
  if (envPath) {
    // Loud failure on a set-but-missing path: silently falling through to the cwd
    // probe masks a deployment misconfiguration (the Dockerfile sets this env).
    if (!existsSync(envPath)) {
      throw new Error(`RAPIDOCR_MODEL_PATH is set but does not exist: ${envPath}`);
    }
    return envPath;
  }

  const pkgRoot = resolve(process.cwd(), "models", "rapidocr");
  if (existsSync(pkgRoot)) {
    return pkgRoot;
  }

  const siblingPath = resolve(process.cwd(), "node_modules", "rapidocr-models", "models");
  if (existsSync(siblingPath)) {
    return siblingPath;
  }

  return null;
}

async function loadDict(path: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
