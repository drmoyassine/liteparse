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
export { parseWithFallbacks } from "./cascade.js";
export type {
  ParseWithFallbacksOptions,
  CascadedResult,
  OcrSlot,
  CascadeInput,
} from "./cascade.js";
export { createVlmOcrEngine } from "./ocr/vlm.js";
export { createRapidOcrEngine } from "./ocr/rapidocr.js";
export type { OcrRunner, RapidOcrOptions } from "./ocr/rapidocr.js";
export { createGraniteDoclingEngine, GRANITE_MODEL } from "./ocr/granite-docling.js";
export type {
  GraniteModelDescriptor,
  GraniteSession,
  GraniteDoclingOptions,
} from "./ocr/granite-docling.js";
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
  WholeDocOcrProvider,
  PdfDocumentLike,
  PdfPageLike,
  PdfLibrary,
} from "./types.js";

// Intelligent Document Router (0.3.0+) — contracts only for now; the classify /
// capabilities / route functions ship in later phases. See ARCHITECTURE.md.
export type {
  Script,
  ExtractionEngine,
  ExecutionLocation,
  RouteStrategy,
  RouteDecision,
  DocumentProfile,
  RuntimeCapabilities,
  RouteOptions,
} from "./router/types.js";

// Intelligent Document Router — Phase 1 modules. classify (DocumentProfile),
// capabilities (RuntimeCapabilities), and languages (script detection + the
// Latin+1 dynamic cap). The worker/model-cache is browser-internal and not
// re-exported here. See ARCHITECTURE.md, ROADMAP.md → Phase 1.
export { classifyDocument } from "./router/classify.js";
export type { ClassifyOptions } from "./router/classify.js";
export { detectCapabilities } from "./router/capabilities.js";
export type { CapabilityOverrides } from "./router/capabilities.js";
export {
  detectScript,
  scriptToRecModel,
  decideBrowserLanguages,
  LATIN,
} from "./router/languages.js";
export type { LanguagePlan } from "./router/languages.js";

// Web Worker message protocol (0.3.0+). The worker + main-thread client ship in
// Phase 2; these contracts are stable now.
export type {
  JobId,
  ProgressStage,
  ParseRequest,
  CancelRequest,
  WorkerInbound,
  ProgressEvent,
  ResultEvent,
  ErrorEvent,
  WorkerOutbound,
} from "./worker/protocol.js";
export { isProgress, isResult, isError } from "./worker/protocol.js";

// Intelligent Document Router — Phase 2 (integration). routeDocument turns a
// (profile, capabilities) pair into an ordered plan; executeRoute walks that plan
// (pure core, fully unit-tested with injected deps); createWorkerOcrClient drives
// the router's Web Worker from the main thread. See ARCHITECTURE.md, ROADMAP.md
// → Phase 2. The worker shell (ocr-worker.ts) is a worker entry point, not
// re-exported from this main-thread entry.
export { routeDocument } from "./router/route.js";
export {
  createWorkerOcrClient,
} from "./worker/worker-client.js";
export type {
  WorkerOcrClient,
  WorkerOcrClientOptions,
  WorkerLike,
  ParseInput,
  ParseHandlers,
  ParseResult,
} from "./worker/worker-client.js";
export { executeRoute } from "./worker/ocr-worker.js";
export type {
  ExecuteRouteInput,
  ExecuteRouteDeps,
  ExecuteRouteResult,
  RouteProgress,
  TextExtractor,
  WorkerConfig,
} from "./worker/ocr-worker.js";
export { configureWorker, getWorkerModelOrigin } from "./worker/ocr-worker.js";
export {
  resolveModel,
  createThrowModelOrigin,
  ModelFetchError,
} from "./worker/model-origin.js";
export type { ModelDescriptor, ModelOrigin } from "./worker/model-origin.js";

export const VERSION = "0.3.0";
