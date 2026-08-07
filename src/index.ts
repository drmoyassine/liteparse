/**
 * liteparse — isomorphic document text extraction.
 *
 * Public surface is intentionally tiny: `parseDocument` plus the types needed to
 * implement the swappable adapters (`RasterAdapter`, `OcrEngine`, `VlmGateway`).
 *
 * Platform-specific adapters are resolved lazily by `runtime.ts` and never
 * imported at the top level, so this module is safe to import in the browser,
 * Node, and Deno without pulling in sharp / onnxruntime-web / pdfjs-dist.
 */

export { parseDocument } from "./pipeline.js";
export { createVlmOcrEngine } from "./ocr/vlm.js";
export { createRapidOcrEngine } from "./ocr/rapidocr.js";
export type { OcrRunner, RapidOcrOptions } from "./ocr/rapidocr.js";
export { setBrowserOcrEngine, getBrowserOcrEngine } from "./runtime.js";
export type {
  ParseOptions,
  ParsedDocument,
  Page,
  DocKind,
} from "./types.js";
export type {
  RasterAdapter,
  PreprocessOptions,
  OcrEngine,
  OcrContext,
  OcrResult,
  VlmGateway,
  VlmReadOptions,
  PdfDocumentLike,
  PdfPageLike,
  PdfLibrary,
} from "./types.js";

export const VERSION = "0.1.0";
