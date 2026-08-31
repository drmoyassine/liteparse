/**
 * Public types for liteparse.
 *
 * These are intentionally decoupled from any optional peer dependency (pdfjs-dist,
 * sharp, onnxruntime-web): the pdfjs document is described structurally so that the
 * raster/ocr/vlm adapter contracts compile without those packages installed.
 */

/** Coarse content category inferred from magic bytes / extension / mime. */
export type DocKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "image"
  | "text"
  | "audio"
  | "other";

/** How the text for a single page was produced. */
export type PageSource = "native" | "ocr" | "vlm" | "stt";

/** Document-level source, derived from the per-page sources. */
export type DocumentSource = PageSource | "mixed" | "none";

/** A single extracted page. */
export interface Page {
  /** 0-based page index (always 0 for non-paginated inputs). */
  index: number;
  text: string;
  source: PageSource;
}

/** Per-page / aggregate counts. */
export interface ParsedMeta {
  pagesProcessed: number;
  /** Total pages in the source PDF (1 for non-paginated inputs). */
  totalPages: number;
  nativePages: number;
  ocrPages: number;
  vlmPages: number;
  /** Pages whose text came from speech transcription (always 0 or 1 — one clip). */
  sttPages: number;
  truncated: boolean;
  chars: number;
}

/** The return value of {@link parseDocument}. Never thrown for content problems. */
export interface ParsedDocument {
  text: string;
  source: DocumentSource;
  pages: Page[];
  warnings: string[];
  kind: DocKind;
  meta: ParsedMeta;
}

/**
 * Minimal structural shape of a pdfjs `PDFDocumentProxy` that adapters and the
 * pipeline need. Kept structural (not imported) so pdfjs-dist stays optional.
 */
export interface PdfDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
}
export interface PdfPageLike {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: Record<string, unknown>) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
}

/** Options passed to a raster adapter when rendering a page. */
export interface PreprocessOptions {
  grayscale?: boolean;
  normalize?: boolean;
  /** Longest edge in px to downscale to (aspect preserved). */
  maxEdge?: number;
}

/** Reads one PDF page into PNG bytes. Implementations: canvas (browser), sharp (node), none. */
export interface RasterAdapter {
  /**
   * Render PDF page `pageIndex` (0-based) of `doc` to a PNG {@link Uint8Array},
   * applying optional preprocessing.
   */
  rasterizePdfPage(
    doc: PdfDocumentLike,
    pageIndex: number,
    opts?: PreprocessOptions,
  ): Promise<Uint8Array>;
  readonly available: boolean;
  readonly runtime: "browser" | "node" | "none";
  readonly name: string;
}

/** Context handed to an OCR engine for a single recognition call. */
export interface OcrContext {
  pageIndex: number;
  totalPages: number;
  hint?: string;
  signal?: AbortSignal;
}

export interface OcrResult {
  text: string;
  /** 0–1 confidence if the engine reports it. */
  confidence?: number;
}

/** Recognises text in an image (PNG/JPEG bytes). Implementations: vlm, rapidocr, none. */
export interface OcrEngine {
  recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult>;
  readonly available: boolean;
  readonly name: string;
}

/**
 * A whole-document OCR provider that reads a file (image or multi-page PDF) in a
 * single call — e.g. a hosted OCR API. Cheaper than the per-page
 * raster+OCR path because it skips local rasterisation. Used as an early cascade
 * slot in {@link parseWithFallbacks} (see `cascade.ts`).
 *
 * Implementations must resolve to `{ text: "" }` (not throw) when they cannot read
 * the document, so the cascade can fall through to the next slot / the heavy path.
 */
export interface WholeDocOcrProvider {
  readonly name: string;
  parseDoc(input: {
    bytes?: Uint8Array;
    /** Public URL of the document — preferred over `bytes` when available. */
    url?: string;
    filename?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

/** Options passed to {@link VlmGateway.readImage}. */
export interface VlmReadOptions {
  pageIndex?: number;
  totalPages?: number;
  /** A free-text hint about the document (e.g. "passport", "academic transcript"). */
  hint?: string;
  signal?: AbortSignal;
  /** MIME type of `png` bytes (often image/png, but image/jpeg for raw photos). */
  mime?: string;
}

/**
 * Injected vision-LLM gateway. The consumer implements this against their own model
 * provider (browser → POSTs to an edge function; server → calls an AI gateway with an
 * `image_url` block). liteparse ships zero provider coupling.
 */
export interface VlmGateway {
  /**
   * Read all text in the image verbatim and return it as plain text.
   * Should return "" (not throw) when the model can't read the image.
   */
  readImage(png: Uint8Array, opts?: VlmReadOptions): Promise<string>;
}

/** Options passed to {@link SttGateway.transcribe} / {@link SttEngine.transcribe}. */
export interface SttTranscribeOptions {
  /** Original filename (a format hint for providers / engines). */
  filename?: string;
  /** MIME type of the audio bytes (e.g. audio/wav, audio/webm). */
  mime?: string;
  /** Spoken-language hint. Omitted ⇒ the engine/gateway auto-detects. */
  language?: "en" | "ar";
  signal?: AbortSignal;
}

/** Result of a transcription. */
export interface SttResult {
  text: string;
  /**
   * 0–1 confidence if the engine reports one (local autoregressive engines do;
   * external gateways typically don't). Used by the confidence-gated cascade.
   */
  confidence?: number;
  /** Language actually transcribed (e.g. "en"), if known. */
  language?: string;
}

/**
 * Injected speech-to-text gateway — the audio counterpart of {@link VlmGateway}.
 * The consumer implements this against their own provider (an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint). Implementations must resolve
 * `{ text: "" }` (not throw) when they cannot transcribe, so the cascade can
 * fall through — the same contract as VlmGateway.
 */
export interface SttGateway {
  /**
   * Transcribe the audio clip verbatim and return it as plain text.
   * Should return "" (not throw) when the clip can't be transcribed.
   */
  transcribe(audio: Uint8Array, opts?: SttTranscribeOptions): Promise<SttResult>;
}

/**
 * Local STT engine (Moonshine via onnxruntime) — the audio counterpart of
 * {@link OcrEngine}. Reports honest per-clip confidence; the caller (pipeline /
 * runner service) applies the confidence gate and escalates to the gateway.
 */
export interface SttEngine {
  transcribe(audio: Uint8Array, opts?: SttTranscribeOptions): Promise<SttResult>;
  readonly available: boolean;
  readonly name: string;
  /** Release model sessions (engine lifecycle / LRU pressure). */
  dispose?(): void;
}

/** Options for {@link parseDocument}. */
export interface ParseOptions {
  /** Original filename (used for sniffing when magic bytes are ambiguous). */
  filename?: string;
  /** MIME type (used for sniffing). */
  mime?: string;
  /** Max input size in bytes. Default 20 MB. Oversized → warning, empty result. */
  maxBytes?: number;
  /**
   * Max pages processed via OCR/VLM (rendering is expensive). Default 20.
   * Native text extraction is not capped by this (cheap); it is bounded by {@link maxChars}.
   */
  maxPages?: number;
  /** Max total output characters. Default 50 000. */
  maxChars?: number;
  /** Per-page OCR/VLM timeout in ms. Default 30 000. */
  perPageTimeoutMs?: number;
  /** OCR engine selection. "auto" (default) uses the best available engine; "off" disables the engine (VLM fallback still applies). */
  ocr?: "auto" | "off";
  /** Inject a raster adapter; otherwise auto-detected per runtime. */
  raster?: RasterAdapter;
  /** Inject an OCR engine; otherwise auto-detected. */
  ocrEngine?: OcrEngine;
  /** Inject a VLM gateway used as the OCR fallback and for raw images. */
  vlm?: VlmGateway;
  /**
   * Inject an STT gateway used to transcribe audio documents (the external tier:
   * quality ceiling and fallback for local STT). Reference implementation:
   * `createServerSttGateway` (subpath `liteparse/stt/server`).
   */
  stt?: SttGateway;
  /**
   * Inject a local STT engine (Moonshine) for audio documents. Wins over the
   * engine registered via `setBrowserSttEngine`.
   */
  sttEngine?: SttEngine;
  /** Spoken-language hint for audio documents. Default: auto-detect. */
  sttLanguage?: "en" | "ar";
  /** Inject a configured pdfjs instance (avoids CDN/worker setup). */
  pdfjs?: PdfLibrary;
  /** Abort parsing. */
  signal?: AbortSignal;
  /** Minimum chars of OCR output before the page is considered well-read. Below this → VLM fallback. Default 3. */
  ocrFloor?: number;
}

/**
 * Structural shape of the pdfjs module the pipeline loads. Only the bits we touch.
 * Consumers may inject their own configured instance via {@link ParseOptions.pdfjs}.
 */
export interface PdfLibrary {
  getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfDocumentLike> };
  GlobalWorkerOptions?: { workerSrc?: string };
}
