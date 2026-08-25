/**
 * CTC greedy decoding shared by every RapidOCR runtime (browser WASM, server
 * onnxruntime-node). Runtime-agnostic: takes a {@link TensorLike} view, never
 * imports onnxruntime.
 */
import type { TensorLike } from "./tensor.js";

/**
 * Decodes ONE row of a (possibly batched) rec output.
 * recOutput shape [G, seq_len, num_chars]; `row` selects the batch element to decode. The
 * single-box path passes a [1, seq_len, num_chars] tensor with row=0.
 *
 * Confidence = mean argmax probability across EMITTED timesteps (non-blank, non-collapsed-
 * repeat). The rec export's final layer is already a softmax over the 97 CTC classes, so the
 * argmax value at each timestep IS the probability the model assigned to the emitted char —
 * average it directly. This is the standard CTC recognition confidence: how sure the model
 * was about each character it actually produced. A box full of garbage has low argmax prob
 * (the model is guessing); a clean box has high prob (~0.95–0.99). Aggregated length-weighted
 * to a doc mean (see ../shared/quality.lengthWeightedConfidence), then gated against
 * OCR_CONFIDENCE_FLOOR.
 *
 * PaddleOCR CTC label layout (authoritative — PaddleOCR rec_postprocess.py):
 *   add_special_char: `dict_character = ['blank'] + dict_character` → blank PREPENDED at
 *   index 0 (get_ignored_tokens() returns [0]). use_space_char appends ' ' to the dict
 *   BEFORE the blank is prepended, so the final order is:
 *     index 0 = blank, indices 1..N = dict[0..N-1], index N+1 = space.
 * v4 shares v3's blank@0/space@last CTC layout; numChars is derived at runtime.
 */
export function ctcDecodeRow(
  recOutput: TensorLike,
  row: number,
  dict: string[],
  onLayout?: (info: CtcLayoutInfo) => void,
): { text: string; confidence: number } {
  const [, seqLen, numChars] = recOutput.dims as [number, number, number];
  const data = recOutput.data as Float32Array;

  const blankId = 0; // PaddleOCR: blank is PREPENDED at index 0 (the FIRST class)
  // PaddleOCR ALWAYS appends space as the LAST char in the CTC charset (dict first, then
  // space appended, then blank prepended at 0): blank@0, dict@1..N, space@N+1. So space is
  // unambiguously the FINAL class — `numChars - 1` — regardless of the exact dict length.
  // The earlier strict guard `numChars === dict.length + 2` was wrong for this model: it
  // outputs 97 classes (dict 94 + blank + space + 1 trailing special token), so the guard
  // set spaceId = -1 and EVERY space was silently dropped — "Generalconditions" instead of
  // "General conditions". Trust the convention (space = last), not arithmetic.
  const spaceId = numChars - 1;

  // One-shot diagnostic payload: the rec model's actual output-class count and the inferred
  // layout. The trailing special class(es) between the dict and space (here: 1 extra) are
  // dropped by labelChar (out of dict range → null). This confirmed the 97-class layout.
  // Probe whether this rec export emits PROBABILITIES or raw LOGITS. The breezedeus
  // en_PP-OCRv4_rec_infer export includes softmax in the graph → output is already probabilities
  // (range [0,1], Σclasses@t ≈ 1), confirmed offline (scripts/ocr-lab/calibrate.ts). That
  // decides the confidence metric: if probs, the argmax value IS the per-char probability and
  // we must NOT re-softmax (re-softmaxing a probability distribution flattens it to ~1/numChars
  // for EVERY box → the OCR_CONFIDENCE_FLOOR gate can never discriminate clean from garbage).
  // A future model swap that exports raw logits would surface here as range outside [0,1].
  if (row === 0 && onLayout) {
    const trailingSpecials = numChars - 1 - dict.length; // classes after the dict, excl. blank@0; last = space
    let rmin = Infinity;
    let rmax = -Infinity;
    let sum0 = 0;
    for (let c = 0; c < numChars; c++) {
      const v = data[c]!;
      if (v < rmin) rmin = v;
      if (v > rmax) rmax = v;
      sum0 += v;
    }
    const isProbs = rmin >= -0.001 && rmax <= 1.001 && Math.abs(sum0 - 1) < 0.05;
    onLayout({ numChars, dictLength: dict.length, trailingSpecials, rmin, rmax, sum0, isProbs });
  }

  const labelChar = (i: number): string | null => {
    if (i === blankId) return null;
    if (i === spaceId) return " ";
    // Dict chars occupy indices 1..N (the blank at index 0 shifts them by one).
    const ci = i - 1;
    if (ci >= 0 && ci < dict.length) return dict[ci] ?? null;
    return null; // out of range → drop (never emit "undefined")
  };

  // Greedy CTC: emit the argmax label when it is not blank and not a collapsed repeat.
  // Track the previous timestep's label (including blank) so a char repeated across a
  // blank separator is emitted twice. Confidence = the argmax value averaged over emitted
  // timesteps (the export emits probabilities — see the probe above).
  //
  // Batched layout: output is [G, seqLen, numChars] row-major, so row `row` starts at
  // rowOffset and each timestep advances by numChars. (For a batch-of-1, row=0 → offset 0.)
  const rowOffset = row * seqLen * numChars;
  let text = "";
  let last = -1;
  let probSum = 0;
  let emitted = 0;
  for (let t = 0; t < seqLen; t++) {
    const base = rowOffset + t * numChars;
    // Pass 1: argmax (bv = the max value at this timestep).
    let bi = 0;
    let bv = -Infinity;
    for (let c = 0; c < numChars; c++) {
      const v = data[base + c]!;
      if (v > bv) {
        bv = v;
        bi = c;
      }
    }
    if (bi !== blankId && bi !== last) {
      const ch = labelChar(bi);
      if (ch) {
        text += ch;
        // Confidence: bv is the argmax value. This rec export outputs PROBABILITIES (verified:
        // range [0,1], Σclasses@t ≈ 1 — see the layout probe), so bv IS the per-timestep
        // recognition probability; average it over emitted chars. The prior softmax-of-logits
        // metric re-softmaxed an already-softmaxed output → ~1/numChars (≈0.01) for EVERY box,
        // clean or garbage, which made the OCR_CONFIDENCE_FLOOR gate non-discriminative (it would
        // have escalated every document). With this metric clean printed text reads ~0.95–0.99,
        // garbled/stylized text ~0.6–0.8 — a real garbage indicator. (Calibrated in ocr-lab.)
        probSum += bv;
        emitted++;
      }
    }
    last = bi;
  }

  return { text, confidence: emitted > 0 ? probSum / emitted : 0 };
}

/** One-shot CTC layout diagnostic (see the probe above). */
export interface CtcLayoutInfo {
  numChars: number;
  dictLength: number;
  /** Classes after the dict, excluding blank@0; the last of them is space. */
  trailingSpecials: number;
  rmin: number;
  rmax: number;
  sum0: number;
  isProbs: boolean;
}

/**
 * A per-engine CTC decoder: owns the one-shot layout log so a runtime that decodes
 * many rows logs the layout exactly once (first row), matching the browser runner's
 * historical behavior. `debug` defaults to TRUE — the repo convention is diagnostics
 * on out of the box; consumers wanting prod-quiet pass `debug: false`.
 */
export function createCtcDecoder(
  dict: string[],
  opts?: { debug?: boolean },
): { decodeRow(recOutput: TensorLike, row: number): { text: string; confidence: number } } {
  const debug = opts?.debug ?? true;
  let logged = false;
  return {
    decodeRow(recOutput, row) {
      const onLayout =
        !logged && debug
          ? (info: CtcLayoutInfo) => {
              logged = true;
              console.log(
                `[ctc] CTC layout: numChars=${info.numChars} dict.length=${info.dictLength} ` +
                  `(blank@0, dict@1..${info.dictLength}, ${info.trailingSpecials} trailing special class(es) incl. space@${info.numChars - 1}). ` +
                  `Rec output range [${info.rmin.toFixed(3)}, ${info.rmax.toFixed(3)}] Σ@t0=${info.sum0.toFixed(2)} ` +
                  `→ ${info.isProbs ? "PROBABILITIES (conf = mean argmax prob — correct)" : "LOGITS (conf = softmax)"}`,
              );
            }
          : undefined;
      // When debug is off (or the layout was already logged) no callback is
      // passed, so the probe inside ctcDecodeRow is skipped entirely.
      return ctcDecodeRow(recOutput, row, dict, onLayout);
    },
  };
}
