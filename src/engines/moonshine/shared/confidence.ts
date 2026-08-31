/**
 * STT confidence — the gate the whole cascade escalates on.
 *
 * Both decoder families (streaming `.ort` and batch transformers.js exports)
 * emit per-step `logits [1,1,32768]` (spike-verified), so confidence is the
 * **per-token probability of the greedy pick** — an autoregressive decoder's
 * own uncertainty, NOT a CTC per-character score and NOT OCR's box score:
 *
 *   STT floor 0.55 vs OCR floor 0.85 is a different measurement on a different
 *   scale. ASR token probabilities of a correct transcript routinely sit in
 *   0.6–0.95; an OCR-style 0.85 floor would escalate nearly every good
 *   transcript. 0.55 is the uncalibrated prior — `stt-lab` replaces it with
 *   per model × language floors (MODEL_STT_CONFIDENCE_FLOORS).
 */
import type { Tokenizer } from "./tokens.js";

/** Uncalibrated prior floor; see module doc before touching. */
export const STT_CONFIDENCE_FLOOR = 0.55;

/** Per model × language overrides, populated by stt-lab (keyed by descriptor id). */
export const MODEL_STT_CONFIDENCE_FLOORS: Record<string, number> = {};

export function sttFloorFor(modelId: string): number {
  return MODEL_STT_CONFIDENCE_FLOORS[modelId] ?? STT_CONFIDENCE_FLOOR;
}

/** Stable log(Σ e^x) over a logits row. */
export function logSumExp(logits: Float32Array | number[]): number {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i]! > max) max = logits[i]!;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i]! - max);
  return max + Math.log(sum);
}

/** One greedy decode step: argmax id + its softmax probability (as log-prob). */
export function greedyPick(logits: Float32Array | number[]): { id: number; logProb: number } {
  let id = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i]! > logits[id]!) id = i;
  return { id, logProb: logits[id]! - logSumExp(logits) };
}

/**
 * Length-weighted geometric mean of token probabilities:
 * exp(Σ logpᵢ·wᵢ / Σwᵢ) with wᵢ = decoded byte length of token i (specials → 0,
 * excluded). Weighting stops a run of confident single-byte tokens from
 * drowning one uncertain long word — the token the text actually rides on.
 */
export function tokenConfidence(
  logProbs: readonly number[],
  tokenizer: Pick<Tokenizer, "tokenLength">,
  tokenIds: readonly (number | bigint)[],
): number {
  let wSum = 0;
  let lpSum = 0;
  for (let i = 0; i < logProbs.length; i++) {
    const w = tokenizer.tokenLength(tokenIds[i] ?? 0);
    if (w <= 0) continue;
    wSum += w;
    lpSum += logProbs[i]! * w;
  }
  if (wSum === 0) return 0;
  return Math.exp(lpSum / wSum);
}
