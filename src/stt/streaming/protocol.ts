/**
 * Dictation message protocol — main thread ↔ dictation worker.
 *
 * A SEPARATE protocol from worker/protocol.ts, deliberately: the parse
 * protocol is request/response with job correlation and a single terminal
 * ResultEvent; dictation is a long-lived bidirectional chunk stream with
 * recurring interims. Forcing both into one protocol would complicate
 * Cancel/Result semantics for every existing parse consumer.
 *
 * Flow:
 *
 *   client                          dictation worker
 *   ──────                          ────────────────
 *   start {language, vad, …}   ──►  builds engine + segmenter, warms
 *                            ◄──  ready
 *   chunk {samples, rate}     ──►  resample → VAD (per frame)
 *                            ◄──  interim {text, startMs, endMs}   (throttled)
 *                            ◄──  final   {text, startMs, endMs}   (per utterance)
 *   stop                      ──►  flush trailing utterance
 *                            ◄──  stopped
 *
 * Samples travel as Float32Array (structured-clone; the client transfers the
 * buffer). The capture worklet's frame message (`{type:"frame"}`) is
 * client-internal and never crosses this boundary — the worklet entry ships
 * standalone (zero imports) and cannot share this module.
 *
 * Types + guards only, no runtime logic — importable by both sides.
 */

import type { SttLanguage } from "../../engines/moonshine/shared/models.js";
import type { SegmentationOptions } from "./segmentation.js";

// ─── Client → Worker ──────────────────────────────────────────────────────────

export interface DictationStart {
  readonly type: "start";
  readonly language?: SttLanguage;
  readonly keepDiacritics?: boolean;
  /** Engine telemetry (the stt-lab line) on/off. Default off in dictation. */
  readonly debug?: boolean;
  /** See MoonshineSttEngineOptions.maxLoadedModels (default 2). */
  readonly maxLoadedModels?: number;
  /** Emit interims from the trailing utterance buffer (default true). */
  readonly interim?: boolean;
  /** VAD tuning (thresholds in shared/segmentation.ts carry the defaults). */
  readonly vad?: Partial<SegmentationOptions>;
}

/** One capture frame: mono float samples at the AudioContext's sample rate. */
export interface DictationChunk {
  readonly type: "chunk";
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** Stop dictation; flush any open utterance, then wait for `stopped`. */
export interface DictationStop {
  readonly type: "stop";
}

export type DictationInbound = DictationStart | DictationChunk | DictationStop;

// ─── Worker → Client ──────────────────────────────────────────────────────────

/** Engine + segmenter constructed; the worker accepts chunks. */
export interface DictationReady {
  readonly type: "ready";
  /** Language this session transcribes in. */
  readonly language: SttLanguage;
}

/**
 * Partial transcript of the OPEN utterance (startMs/endMs are session
 * offsets; endMs grows with each interim). Always superseded by the
 * utterance's final.
 */
export interface DictationInterim {
  readonly type: "interim";
  readonly text: string;
  readonly confidence?: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** A finalized utterance. `text` may be "" (the engine gate discarded it). */
export interface DictationFinal {
  readonly type: "final";
  readonly text: string;
  readonly confidence?: number;
  readonly language: SttLanguage;
  readonly startMs: number;
  readonly endMs: number;
  /** Why the utterance ended ("flush" = user hit stop mid-utterance). */
  readonly reason: "hangover" | "max-length" | "flush";
}

export interface DictationError {
  readonly type: "error";
  readonly message: string;
  /** Which leg failed — the client decides severity from it. */
  readonly stage: "engine" | "audio" | "protocol";
}

/** The stop's flush completed; no further messages until the next start. */
export interface DictationStopped {
  readonly type: "stopped";
}

export type DictationOutbound =
  | DictationReady
  | DictationInterim
  | DictationFinal
  | DictationError
  | DictationStopped;

// ─── guards ───────────────────────────────────────────────────────────────────

function isObject(m: unknown): m is Record<string, unknown> {
  return typeof m === "object" && m !== null;
}

export function isDictationStart(m: unknown): m is DictationStart {
  return isObject(m) && m.type === "start";
}

export function isDictationChunk(m: unknown): m is DictationChunk {
  return isObject(m) && m.type === "chunk" && m.samples instanceof Float32Array;
}

export function isDictationStop(m: unknown): m is DictationStop {
  return isObject(m) && m.type === "stop";
}

export function isDictationReady(m: unknown): m is DictationReady {
  return isObject(m) && m.type === "ready";
}

export function isDictationInterim(m: unknown): m is DictationInterim {
  return isObject(m) && m.type === "interim" && typeof m.text === "string";
}

export function isDictationFinal(m: unknown): m is DictationFinal {
  return isObject(m) && m.type === "final" && typeof m.text === "string";
}

export function isDictationError(m: unknown): m is DictationError {
  return isObject(m) && m.type === "error" && typeof m.message === "string";
}

export function isDictationStopped(m: unknown): m is DictationStopped {
  return isObject(m) && m.type === "stopped";
}
