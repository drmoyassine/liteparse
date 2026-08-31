/**
 * Web Worker ↔ main-thread message protocol for the Intelligent Document Router.
 *
 * The worker owns the entire browser document pipeline (pdfjs render →
 * preprocess → engine per route) and never blocks the UI. It receives a
 * pre-classified {@link ParseRequest} (classification happens on the main
 * thread at attach time) and an already-routed {@link RouteDecision}, executes
 * the ordered strategies, and streams progress + a final result back.
 *
 * This file is **types + minimal type-guard helpers only** — no runtime logic —
 * so it can be imported freely by both the worker and the main-thread client
 * without pulling in engine code.
 *
 * See ARCHITECTURE.md → Web Worker Architecture, ROADMAP.md → Phase 2.
 */

import type { ParsedDocument } from "../types.js";
import type {
  DocumentProfile,
  ExtractionEngine,
  RouteDecision,
} from "../router/types.js";

/** Correlation id shared across every message belonging to one parse job. */
export type JobId = string | number;

/** Processing stage, surfaced in {@link ProgressEvent} for the UI. */
export type ProgressStage =
  | "rendering" // pdfjs page → OffscreenCanvas
  | "preprocess" // grayscale / deskew / normalize
  | "rapidocr"
  | "granite"
  | "vlm"
  | "stt" // audio transcription (Moonshine / external gateway)
  | "finalizing"; // assembling ParsedDocument

// ─── Main → Worker ────────────────────────────────────────────────────────────

/** Start a parse job. The client transfers `bytes` (not copies it). */
export interface ParseRequest {
  readonly type: "parse";
  readonly id: JobId;
  /** Document bytes. Sent via `postMessage(msg, [bytes])` (transferable). */
  readonly bytes: ArrayBuffer;
  readonly filename?: string;
  /** Pre-computed classification — the worker must NOT re-classify. */
  readonly profile: DocumentProfile;
  /** The ordered execution plan to run. */
  readonly route: RouteDecision;
}

/** Cancel an in-flight job by id (AbortSignal can't cross the worker boundary). */
export interface CancelRequest {
  readonly type: "cancel";
  readonly id: JobId;
}

export type WorkerInbound = ParseRequest | CancelRequest;

// ─── Worker → Main ────────────────────────────────────────────────────────────

/** Per-page / per-stage progress. The client surfaces this in the UI
 *  (e.g. "Processing page 2/5… RapidOCR"). */
export interface ProgressEvent {
  readonly type: "progress";
  readonly id: JobId;
  readonly pageIndex: number;
  readonly totalPages: number;
  readonly stage: ProgressStage;
  /** Engine currently running, for richer UI labels. */
  readonly engine?: ExtractionEngine;
}

/** Success. The worker returns a full {@link ParsedDocument} so the client can
 *  use it directly (it already conforms to `parseDocument`'s return shape). */
export interface ResultEvent {
  readonly type: "result";
  readonly id: JobId;
  readonly document: ParsedDocument;
  /** Engine that actually produced the text (telemetry). */
  readonly engine?: ExtractionEngine;
}

/** Hard failure (the cascade exhausted all strategies, or an unrecoverable
 *  error). Soft "no text" is a ResultEvent with an empty document, not this. */
export interface ErrorEvent {
  readonly type: "error";
  readonly id: JobId;
  readonly message: string;
  readonly stage?: ProgressStage;
}

export type WorkerOutbound = ProgressEvent | ResultEvent | ErrorEvent;

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isProgress(m: WorkerOutbound): m is ProgressEvent {
  return m.type === "progress";
}

export function isResult(m: WorkerOutbound): m is ResultEvent {
  return m.type === "result";
}

export function isError(m: WorkerOutbound): m is ErrorEvent {
  return m.type === "error";
}
