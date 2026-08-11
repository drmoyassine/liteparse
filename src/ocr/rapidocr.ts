import type { OcrContext, OcrEngine, OcrResult } from "../types.js";

/**
 * Browser OCR engine over a pluggable {@link OcrRunner} — typically a community
 * package that runs RapidOCR / PaddleOCR models on `onnxruntime-web` (e.g.
 * `client-side-ocr`, `@paddleocr/paddleocr-js`). There is no official RapidOCR
 * npm package, and reimplementing the det/rec/angle pipeline belongs in those
 * dedicated projects; liteparse provides the integration: a typed engine, lazy
 * browser gating, and a one-time registry so `parseDocument` uses it automatically.
 *
 * The runner does the heavy lifting (model download, inference) and is injected,
 * so liteparse itself stays dependency-free. Register once at app start:
 *
 *   import { createOCR } from "client-side-ocr";
 *   import { createRapidOcrEngine, setBrowserOcrEngine } from "liteparse";
 *   const ocr = await createOCR();
 *   setBrowserOcrEngine(createRapidOcrEngine({
 *     runner: { recognize: async (image) => { ... return { text }; } },
 *   }));
 */

/** Low-level recogniser the consumer wires to a real OCR package. */
export interface OcrRunner {
  recognize(
    image: Uint8Array,
    ctx: { signal?: AbortSignal },
  ): Promise<{ text: string; confidence?: number }>;
  /** Optional: release model sessions / WASM resources. */
  dispose?(): void;
}

export interface RapidOcrOptions {
  runner: OcrRunner;
}

export function createRapidOcrEngine(opts: RapidOcrOptions): OcrEngine {
  return {
    name: "rapidocr",
    available: true,
    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      const out = await opts.runner.recognize(image, { signal: ctx.signal });
      return { text: (out.text ?? "").trim(), confidence: out.confidence };
    },
  };
}
