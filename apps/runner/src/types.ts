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
