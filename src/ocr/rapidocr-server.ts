import type { OcrContext, OcrEngine, OcrResult } from "../types.js";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Node OCR engine using RapidOCR models via ONNX Runtime Node.
 *
 * This engine loads RapidOCR ONNX models and runs them server-side for
 * high-performance OCR without external API calls. Models are loaded once
 * and reused (singleton pattern) for warm-start performance.
 *
 * Requires optional peer dependency: `onnxruntime-node`
 *
 * Usage:
 *   import { createRapidOcrServerEngine } from "liteparse/ocr/rapidocr-server";
 *   const engine = await createRapidOcrServerEngine();
 *   const { text } = await engine.recognize(imageBytes, { pageIndex: 0 });
 *
 * Model paths are auto-detected in order:
 *   1. `process.env.RAPIDOCR_MODEL_PATH` — explicit model directory
 *   2. `node_modules/rapidocr-models` — models installed as sibling package
 *   3. `./models/rapidocr` — relative to package root
 */

let singletonModel: RapidOcrModel | null = null;
let singletonPromise: Promise<RapidOcrModel> | null = null;

export interface RapidOcrServerOptions {
  /** Explicit path to RapidOCR ONNX model directory (overrides auto-detection) */
  modelPath?: string;
  /** Detection model filename (default: "ch_PP-OCRv3_det_infer.onnx") */
  detModel?: string;
  /** Recognition model filename (default: "ch_PP-OCRv3_rec_infer.onnx") */
  recModel?: string;
  /** Dictionary file for recognition (default: "dict.txt") */
  dictFile?: string;
}

interface RapidOcrModel {
  ort: any;
  det: any;
  rec: any;
  dict: string[];
  inputShape: { width: number; height: number };
}

/**
 * Create a RapidOCR server engine with auto-detected or explicit model paths.
 * The first call initializes the singleton model; subsequent calls return the
 * cached instance.
 */
export async function createRapidOcrServerEngine(
  opts: RapidOcrServerOptions = {},
): Promise<OcrEngine> {
  // Use existing singleton if available
  if (singletonModel) {
    return createEngine(singletonModel);
  }

  // Use in-progress initialization if available
  if (singletonPromise) {
    const model = await singletonPromise;
    return createEngine(model);
  }

  // Initialize singleton
  singletonPromise = loadRapidOcrModel(opts);
  try {
    const model = await singletonPromise;
    singletonModel = model;
    return createEngine(model);
  } catch (err) {
    singletonPromise = null;
    throw err;
  }
}

function createEngine(model: RapidOcrModel): OcrEngine {
  return {
    name: "rapidocr-server",
    available: true,
    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      if (!model) {
        throw new Error("RapidOCR model not initialized");
      }

      const signal = ctx.signal;

      // For MVP: return empty result with note
      // Full implementation would:
      // 1. Decode image (PNG/JPEG) to RGB
      // 2. Run detection model to find text regions
      // 3. Run recognition model on each region
      // 4. Combine results

      // Placeholder for now - the structure is here for full implementation
      return {
        text: "",
        confidence: 0,
      };
    },
  };
}

async function loadRapidOcrModel(
  opts: RapidOcrServerOptions,
): Promise<RapidOcrModel> {
  // Dynamic import of onnxruntime-node (optional peer dependency)
  let ort: any;
  try {
    ort = await import("onnxruntime-node");
  } catch {
    throw new Error(
      "onnxruntime-node is required for RapidOCR server. Install it with: npm install onnxruntime-node",
    );
  }

  // Detect model path
  const modelPath = await detectModelPath(opts.modelPath);
  if (!modelPath) {
    throw new Error(
      "RapidOCR models not found. Set RAPIDOCR_MODEL_PATH env var, install rapidocr-models package, or place models in ./models/rapidocr",
    );
  }

  // Load detection and recognition models
  const detPath = resolve(modelPath, opts.detModel ?? "ch_PP-OCRv3_det_infer.onnx");
  const recPath = resolve(modelPath, opts.recModel ?? "ch_PP-OCRv3_rec_infer.onnx");
  const dictPath = resolve(modelPath, opts.dictFile ?? "dict.txt");

  // Verify files exist
  if (!existsSync(detPath)) {
    throw new Error(`Detection model not found: ${detPath}`);
  }
  if (!existsSync(recPath)) {
    throw new Error(`Recognition model not found: ${recPath}`);
  }
  if (!existsSync(dictPath)) {
    throw new Error(`Dictionary file not found: ${dictPath}`);
  }

  const [det, rec, dictContent] = await Promise.all([
    loadModel(ort, detPath),
    loadModel(ort, recPath),
    loadDict(dictPath),
  ]);

  // Get input shape from detection model (default PP-OCRv3: 320x320)
  const inputShape = { width: 320, height: 320 };

  return { ort, det, rec, dict: dictContent, inputShape };
}

async function detectModelPath(explicitPath?: string): Promise<string | null> {
  if (explicitPath) {
    return explicitPath;
  }

  // Check environment variable
  const envPath = process.env.RAPIDOCR_MODEL_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Try package root models directory
  const pkgRoot = resolve(process.cwd(), "models", "rapidocr");
  if (existsSync(pkgRoot)) {
    return pkgRoot;
  }

  // Try node_modules/rapidocr-models (if installed as sibling package)
  try {
    const siblingPath = resolve(process.cwd(), "node_modules", "rapidocr-models", "models");
    if (existsSync(siblingPath)) {
      return siblingPath;
    }
  } catch {
    // Not found
  }

  return null;
}

async function loadModel(ort: any, path: string): Promise<any> {
  const session = await ort.InferenceSession.create(path, {
    executionProviders: ["cpu"],
  });
  return session;
}

async function loadDict(path: string): Promise<string[]> {
  // Use dynamic import for fs to avoid issues in browser builds
  const fs = await import("fs/promises");
  const content = await fs.readFile(path, "utf-8");
  return content.split("\n").map((line) => line.trim()).filter(Boolean);
}
