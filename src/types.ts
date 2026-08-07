/**
 * Public types for liteparse.
 *
 * These are intentionally decoupled from any optional peer dependency (pdfjs-dist,
 * sharp, onnxruntime-web): the pdfjs document is described structurally so that the
 * raster/ocr/vlm adapter contracts compile without those packages installed.
 */

/** Coarse content category inferred from magic bytes / extension / mime. */
export type DocKind = "pdf" | "docx" | "xlsx" | "csv" | "image" | "text" | "other";

/** How the text for a single page was produced. */
export type PageSource = "native" | "ocr" | "vlm";

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
  /** Inject a configured pdfjs instance (avoids CDN/worker setup). */
  pdfjs?: PdfLibrary;
  /** Abort parsing. */
  signal?: AbortSignal;
  /** Minimum non-whitespace chars on a page before its native text is considered present. Default 8. */
  nativeTextFloor?: number;
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
