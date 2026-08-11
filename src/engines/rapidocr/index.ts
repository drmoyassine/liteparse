/**
 * PP-OCRv4 browser OCR engine — fully integrated RapidOCR implementation.
 *
 * This is a drop-in browser OCR engine that runs PP-OCRv4 detection + recognition
 * entirely in the browser via onnxruntime-web. It includes all latency optimizations:
 * - Multi-threaded WASM (COEP credentialless, ~1.4× threading bandwidth-bound)
 * - Sequential per-box recognition (batching is a net loss in ~1.4×-threaded WASM)
 * - Eager warm-up support
 * - Self-hosted pdf.js worker (COEP-safe)
 *
 * Consumer app creates the Worker instance and calls createRapidOcrRunner:
 *
 *   import { createRapidOcrRunner } from "liteparse/engines/rapidocr";
 *
 *   // In your worker file or main thread:
 *   const runner = createRapidOcrRunner({ eagerInit: true });
 *   const { text } = await runner.recognize(image, { signal });
 */

export { createRapidOcrRunner } from "./rapidocr-onnx-runner.js";
export { createPublicModelOrigin } from "./model-origin-hf.js";

// Re-export types for convenience
export type { OcrContext, OcrResult, OcrEngine } from "../../types.js";
