/**
 * Wire contract — mirrors studygram's parse-document edge function EXACTLY so
 * the forwarders can pass responses through unchanged.
 */

/** Caller-resolved VLM config (the edge resolves secret names; the key lives for one request). */
export interface RequestedVlmOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  keyHeader?: string;
  maxTokens?: number;
  temperature?: number;
}

/** AMS vision endpoint: the runner POSTs each page image here instead of calling a provider. */
export interface RequestedVisionEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface RequestedParseOptions {
  vlm?: RequestedVlmOptions;
  /** Alternative to `vlm`: defer vision to the AMS (its settings, logs, data rules). */
  vlmEndpoint?: RequestedVisionEndpoint;
  maxPages?: number;
  perPageTimeoutMs?: number;
  maxChars?: number;
  /** "per-page" (default from RUNNER_PAGE_OUTPUT) or "single" (pre-0.6 shape). */
  pageOutput?: "per-page" | "single";
  /** ISO 639-1 hint (e.g. "ar") — picks the OCR model for scanned pages. */
  languageHint?: string;
  /** The AMS's own request id, passed to the vision step untouched. */
  requestId?: string;
}

/** One page on the wire. */
export interface PageJson {
  page: number;
  text: string;
  method: string;
  engine?: string;
  reason?: string;
  script?: string;
  flags?: string[];
}

/** POST /parse body. */
export interface ParseRequestBody {
  data: string; // base64 document bytes
  filename?: string;
  options?: RequestedParseOptions;
}

/** 200 body — same keys as the parse-document edge function. */
export interface ParseResponseJson {
  text: string;
  kind: string;
  source: string;
  page_count: number;
  warnings: string[];
  duration_ms: number;
  pages: PageJson[];
  encoding?: string;
  format?: string;
}

/** POST /ocr body — one page image (browser → runner fallback). */
export interface OcrRequestBody {
  data: string;
  script?: string;
  pageNumber?: number;
  totalPages?: number;
  documentName?: string;
  requestId?: string;
}

/** Error body for every non-200. */
export interface ErrorJson {
  error: string;
}

/** Caller-resolved external STT gateway (slot 3 — the quality ceiling / fallback). */
export interface RequestedSttOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  keyHeader?: string;
  temperature?: number;
}

export interface RequestedTranscribeOptions {
  /** "en" (default) or "ar" — selects the slot-1 local model. */
  language?: "en" | "ar";
  /** Keep Arabic diacritics (default: the runner strips tashkeel). */
  keepDiacritics?: boolean;
  /** External gateway for escalations above the local cascade. */
  stt?: RequestedSttOptions;
}

/** POST /transcribe body — same envelope as /parse ({data: base64, ...}). */
export interface TranscribeRequestBody {
  data: string; // base64 audio bytes (WAV PCM16)
  filename?: string;
  options?: RequestedTranscribeOptions;
}

/** 200 body — the exact key set is test-asserted. */
export interface TranscribeResponseJson {
  text: string;
  language: string;
  /** Model id that produced the text, or "stt-gateway". */
  engine: string;
  /** Honest local confidence; null when the external gateway produced the text. */
  confidence: number | null;
  warnings: string[];
  duration_ms: number;
}
