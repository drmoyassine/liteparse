/**
 * stt-lab telemetry — ONE flat, greppable line per transcription.
 *
 * The lab (studygram's calibration harness) lives in the consumer repo; this is
 * the repo-side deliverable it parses. Everything the floor-calibration work
 * needs rides the line: latency (RTF), confidence distribution (mean/min/worst
 * tokens), and the two known failure signatures — a decoder hallucinating on
 * (near-)silence, and a degenerate repetition loop (the AR-sine smoke case:
 * 194 tokens, one repeated word, conf 0.869 — high confidence, wrong text).
 *
 * Emitted debug-gated by both engines (like OCR telemetry), never to the API.
 */
import { tokenConfidence } from "./confidence.js";
import type { SttLanguage } from "./models.js";
import type { Tokenizer } from "./tokens.js";

/** A token whose per-step logprob is ≤ the 5 worst of the clip. */
const WORST_TOKENS = 5;

/**
 * RMS below this on the model-input samples counts as (near-)silence. −46 dBFS
 * in PCM16 terms — a working mic in a quiet room reads ≥ 10× higher; only a
 * muted/dead capture or trailing pad lands here.
 */
const SILENCE_RMS = 0.005;

/** A loop where the single most frequent token is ≥40% of a ≥4-token clip. */
const REPEAT_MIN_TOKENS = 4;
const REPEAT_RATIO = 0.4;

export interface SttDebugStats {
  modelId: string;
  language: SttLanguage;
  /** Wall time of the decode (model input ready → last decoder step). */
  decodeSeconds: number;
  /** Duration of the model-input clip (16 kHz samples / 16). */
  audioSeconds: number;
  ids: readonly number[];
  logProbs: readonly number[];
  tokenizer: Pick<Tokenizer, "decodeIds" | "tokenLength">;
  /** RMS of the model-input samples (silence detector). */
  rms: number;
  /** Whether tashkeel was stripped (the default) or kept. */
  diacriticsStripped: boolean;
}

/**
 * Render the one-line transcript record, e.g.
 *
 * ```
 * [moonshine] model=moonshine-streaming-tiny-en lang=en audio_s=1.60 decode_s=1.02 rtf=0.64 tokens=14 mean_p=0.913 min_p=0.621 worst=[▁the:0.62 ▁a:0.71 ...] silence_halluc=no repeat_loop=no diacritics=stripped
 * ```
 *
 * Whitespace inside a worst-token is rendered as `␣` so the line stays one line
 * (SentencePiece pieces carry their leading space marker).
 */
export function sttDebugLine(s: SttDebugStats): string {
  const meanProb = tokenConfidence(s.logProbs, s.tokenizer, s.ids);

  // Weighted min + worst tokens: specials (tokenLength 0) never qualify.
  let minLogProb = 0;
  const weighted: { index: number; logProb: number; text: string }[] = [];
  for (let i = 0; i < s.logProbs.length; i++) {
    if (s.tokenizer.tokenLength(s.ids[i] ?? 0) <= 0) continue;
    const logProb = s.logProbs[i]!;
    if (!weighted.length || logProb < minLogProb) minLogProb = logProb;
    weighted.push({ index: i, logProb, text: s.tokenizer.decodeIds([s.ids[i]!]) });
  }
  const worst = weighted
    .sort((a, b) => a.logProb - b.logProb)
    .slice(0, WORST_TOKENS)
    .map((w) => `${w.text.replace(/\s/g, "␣") || "∅"}:${Math.exp(w.logProb).toFixed(2)}`)
    .join(" ");

  // Repetition loop: the most frequent token's share of the clip.
  const counts = new Map<number, number>();
  let topCount = 0;
  for (const id of s.ids) {
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    if (n > topCount) topCount = n;
  }
  const repeatLoop = s.ids.length >= REPEAT_MIN_TOKENS && topCount / s.ids.length >= REPEAT_RATIO;
  const silenceHalluc = s.rms < SILENCE_RMS && s.ids.length >= 3;

  const rtf = s.audioSeconds > 0 ? (s.decodeSeconds / s.audioSeconds).toFixed(2) : "n/a";
  return (
    `[moonshine] model=${s.modelId} lang=${s.language} ` +
    `audio_s=${s.audioSeconds.toFixed(2)} decode_s=${s.decodeSeconds.toFixed(2)} rtf=${rtf} ` +
    `tokens=${s.ids.length} mean_p=${meanProb.toFixed(3)} min_p=${weighted.length ? Math.exp(minLogProb).toFixed(3) : "n/a"} ` +
    `worst=[${worst}] silence_halluc=${silenceHalluc ? "yes" : "no"} ` +
    `repeat_loop=${repeatLoop ? "yes" : "no"} diacritics=${s.diacriticsStripped ? "stripped" : "kept"}`
  );
}

/** RMS of a sample window (the silence detector's input). */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}
