/**
 * OCR quality gates + geometry helpers shared by every RapidOCR runtime
 * (browser WASM runner, server onnxruntime-node engine).
 *
 * Single source of the calibration learned on the browser path (ocr-lab):
 * the doc/per-box confidence floors and the min-box pre-filter. The values
 * and their reasoning live HERE, not per-runtime, so the server engine gets
 * the identical garbage-detection behavior for free.
 */

/**
 * OCR quality gate ("garbage indicator" → VLM fallback).
 *
 * The runner computes a document-level recognition confidence = length-weighted mean of
 * per-box CTC argmax probability (the rec export is already softmax'd, so the argmax value at
 * each emitted timestep IS that char's probability — averaged, NOT re-softmaxed). PP-OCRv4 on
 * clean printed text sits ~0.93–0.98; stylized/colored/low-contrast
 * text (the flyer that produced "The Spansh ls ae d mdit in distce") drops to ~0.5–0.7,
 * dragging the doc mean down.
 *
 * If the doc mean drops below this floor, the OCR text is DISCARDED (returned as "") so the
 * liteparse cascade under-yields and the existing fallback path re-reads the document via
 * the VLM — which handles this kind of content far better than a CTC rec model. Risk
 * (1 − confidence) must stay ≤ 15%, else escalate to VLM.
 *
 * Idiomatic: liteparse's own Granite engine uses the identical pattern (`confidence < 0.2
 * → {text:""}` → cascade descends). Calibrated: 0.90 initial spec; lowered to 0.85 on
 * 2026-08-26 after a real scanned passport (runner prod log) read CORRECTLY at doc conf
 * 0.899 yet escalated — the two MRZ lines were 43% of the doc's chars (monospace `<` runs
 * read at 0.745/0.933 CTC confidence), structurally dragging the length-weighted mean to
 * ~0.87–0.90 on ANY perfectly-read MRZ-bearing doc (passport/visa/ID). Every one would
 * have paid a ~24s VLM leg for text local OCR already had. At 0.85 the garbage class
 * (stylized/colored text, observed ~0.5–0.7) is still gated hard. Keep calibrating via
 * the per-box/doc confidence logs: clean docs escalating → lower; garbage surviving →
 * raise or switch to a per-box rule.
 */
export const OCR_CONFIDENCE_FLOOR = 0.85;

/**
 * Per-box recognition confidence floor. A box whose CTC confidence falls below this is
 * treated as GARBAGE and dropped from BOTH the output text and the doc-confidence mean —
 * BEFORE the doc-level {@link OCR_CONFIDENCE_FLOOR} gate runs.
 *
 * Why per-box, not just doc-level: a length-weighted doc mean CANNOT distinguish "10% of the
 * chars are an UNREADABLE SCRIPT" (Arabic via a Latin model → garbage at conf 0.2–0.7) from
 * "10% of the chars are RISKILY recognized". On a bilingual travel-insurance form the
 * unreadable Arabic dragged the doc mean to 0.891 — just under 0.90 — so the doc-level gate
 * discarded ~2450 chars of near-perfect English alongside the Arabic (52s of OCR → zero text).
 * Filtering garbage boxes first means the doc mean reflects ONLY the text the model actually
 * read, so the gate escalates ONLY when the RECOGNIZED text is itself poor (a systemic
 * medium-confidence doc, e.g. a stylized flyer). For such a doc the survivors still average
 * < OCR_CONFIDENCE_FLOOR → still escalates, so the original guarantee is preserved.
 *
 * 0.60 = "≥40%-likely-wrong per char is garbage". On the sample form every real English/numeric
 * line read at ≥0.88 while the Arabic garbage sat at 0.2–0.7, so 0.60 cleanly separates them.
 * Calibrate via the per-box breakdown log (filtered-out boxes are marked ✗).
 */
export const PER_BOX_CONFIDENCE_FLOOR = 0.60;

/**
 * Minimum box side (px, original-image space) worth recognizing. A box shorter than this
 * can't hold legible text — the rec model resizes crops to a fixed 48px height, so a <6px-tall
 * box is an ≥8× upscale that only ever yields garbage/empty. Dropping it pre-recognition saves
 * a full rec inference per noise box and keeps detection noise out of the output. PP-OCR's
 * reference pipeline applies the same min-size filter after DB post-processing. Conservative
 * (6px) so it never drops real text — its main value is cleaner output; any speed gain depends
 * on how many detected boxes are sub-6px noise (vs. normal-size-but-empty cells, which the
 * per-box confidence filter catches post-recognition).
 */
export const MIN_BOX_SIDE_PX = 6;

/**
 * Text bounding box (polygon coordinates) — the shape both the browser runner and the
 * server engine use between detection and recognition.
 */
export interface TextBox {
  points: number[][]; // 4 points [[x,y], ...] in image coordinates
  text?: string; // filled after recognition
  score?: number; // detection confidence
  recConf?: number; // recognition confidence (0–1, CTC mean softmax of emitted chars)
}

/**
 * Minimum of the bounding-rect width/height of a box's 4 polygon points, in original-image px.
 * Used by the pre-recognition geometry filter (see {@link MIN_BOX_SIDE_PX}): a box whose shortest
 * side is tiny can't hold legible text and is not worth a rec inference. Defensive against a
 * malformed (fewer-point) box — returns Infinity for an empty polygon (kept) so only real
 * sub-min boxes are dropped.
 */
export function minBoxSide(b: TextBox): number {
  const pts = b.points;
  if (!pts || pts.length === 0) return Infinity;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    const x = p[0]!;
    const y = p[1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

/**
 * Document-level recognition confidence: length-weighted mean of per-box CTC confidence over
 * the KEPT (confident) boxes. Weight by non-whitespace char count so a long clean line counts
 * more than a short one. Returns 0 for an empty set.
 */
export function lengthWeightedConfidence(
  boxes: Array<{ text?: string; recConf?: number }>,
): number {
  let lenSum = 0;
  let weightedConf = 0;
  for (const b of boxes) {
    const len = (b.text || "").replace(/\s/g, "").length;
    lenSum += len;
    weightedConf += (b.recConf ?? 0) * len;
  }
  return lenSum > 0 ? weightedConf / lenSum : 0;
}
