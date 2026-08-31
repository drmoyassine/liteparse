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

export interface RequestedParseOptions {
  vlm?: RequestedVlmOptions;
  maxPages?: number;
  perPageTimeoutMs?: number;
  maxChars?: number;
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
