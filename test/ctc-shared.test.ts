import { describe, expect, it, vi } from "vitest";
import {
  createCtcDecoder,
  ctcDecodeRow,
  type CtcLayoutInfo,
} from "../src/engines/rapidocr/shared/ctc-decode.js";
import { readingOrderSort } from "../src/engines/rapidocr/shared/reading-order.js";
import {
  lengthWeightedConfidence,
  minBoxSide,
  type TextBox,
} from "../src/engines/rapidocr/shared/quality.js";
import type { TensorLike } from "../src/engines/rapidocr/shared/tensor.js";

/**
 * Synthetic-rec-output fixture shaped like the real en_PP-OCRv4_rec_infer export:
 * blank@0, dict@1..N, trailing special class(es), space LAST (numChars - 1).
 * Each timestep puts the target label's probability at `p` and ~0 elsewhere, so
 * argmax picks the target. No onLayout callback is passed, so the probe is skipped
 * and the values don't need to sum to 1.
 */
function syntheticRow(
  seqLen: number,
  numChars: number,
  steps: Array<{ label: number; p: number } | null>,
): TensorLike {
  const data = new Float32Array(seqLen * numChars); // all 0 elsewhere
  steps.forEach((step, t) => {
    if (step) data[t * numChars + step.label] = step.p;
  });
  return { dims: [1, seqLen, numChars], data };
}

describe("ctcDecodeRow", () => {
  const dict = ["h", "e", "l", "o"]; // blank@0, h@1, e@2, l@3, o@4, special@5, space@6
  const numChars = 7;

  it("greedy-decodes: collapse repeats, repeat across blank, space, drop specials", () => {
    const t = syntheticRow(10, numChars, [
      { label: 1, p: 0.97 }, // h
      { label: 2, p: 0.95 }, // e
      { label: 2, p: 0.94 }, // e — collapsed repeat → dropped
      { label: 0, p: 0.99 }, // blank
      { label: 2, p: 0.93 }, // e — repeat ACROSS blank → emitted
      { label: 3, p: 0.96 }, // l
      { label: 6, p: 0.9 }, // space (numChars - 1)
      { label: 4, p: 0.92 }, // o
      { label: 5, p: 0.99 }, // trailing special — dropped, EXCLUDED from confidence
      { label: 0, p: 0.99 }, // blank
    ]);
    const { text, confidence } = ctcDecodeRow(t, 0, dict);
    expect(text).toBe("heel o");
    // Mean argmax prob over the 6 EMITTED chars only (special/blank/repeat excluded).
    // Precision 6: the probs pass through Float32 storage (~1e-8 rounding).
    expect(confidence).toBeCloseTo((0.97 + 0.95 + 0.93 + 0.96 + 0.9 + 0.92) / 6, 6);
  });

  it("decodes the selected row of a batched output", () => {
    const seqLen = 4;
    const row0 = [1, 0, 1, 0].map((l, t) => ({ label: l, p: 0.9 })); // "hh"
    const row1 = [3, 0, 3, 0].map((l, t) => ({ label: l, p: 0.8 })); // "ll"
    const data = new Float32Array(2 * seqLen * numChars);
    row0.forEach((s, t) => (data[t * numChars + s.label] = s.p));
    row1.forEach((s, t) => (data[seqLen * numChars + t * numChars + s.label] = s.p));
    const batched: TensorLike = { dims: [2, seqLen, numChars], data };

    expect(ctcDecodeRow(batched, 0, dict).text).toBe("hh");
    expect(ctcDecodeRow(batched, 1, dict).text).toBe("ll");
    expect(ctcDecodeRow(batched, 1, dict).confidence).toBeCloseTo(0.8, 6);
  });

  it("returns empty text with confidence 0 for an all-blank row", () => {
    const t = syntheticRow(3, numChars, [
      { label: 0, p: 0.99 },
      { label: 0, p: 0.98 },
      { label: 0, p: 0.97 },
    ]);
    expect(ctcDecodeRow(t, 0, dict)).toEqual({ text: "", confidence: 0 });
  });

  it("emits a space even when the dict would not (space = LAST class, not dict.length + 1)", () => {
    // Regression shape of the old `numChars === dict.length + 2` guard: with a trailing
    // special class the guard disabled space — every space silently vanished.
    const t = syntheticRow(3, numChars, [
      { label: 1, p: 0.95 }, // h
      { label: 6, p: 0.9 }, // space
      { label: 4, p: 0.95 }, // o
    ]);
    expect(ctcDecodeRow(t, 0, dict).text).toBe("h o");
  });

  it("reports the layout probe (probabilities vs logits) on row 0 when asked", () => {
    // Sum of t0 ≈ 1 and all values in [0,1] → detected as probabilities.
    const seqLen = 1;
    const data = new Float32Array(numChars);
    data[0] = 0.3;
    data[1] = 0.7;
    const t: TensorLike = { dims: [1, seqLen, numChars], data };
    const seen: CtcLayoutInfo[] = [];
    ctcDecodeRow(t, 0, dict, (i) => seen.push(i));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.numChars).toBe(numChars);
    expect(seen[0]!.dictLength).toBe(dict.length);
    // Classes after the dict excluding blank@0: special@5 + space@6 → 2 (last = space).
    expect(seen[0]!.trailingSpecials).toBe(2);
    expect(seen[0]!.isProbs).toBe(true);
  });
});

describe("createCtcDecoder", () => {
  const dict = ["a", "b"];

  it("decodes via the shared function with the bound dict", () => {
    const dec = createCtcDecoder(dict, { debug: false });
    const t = syntheticRow(2, 4, [
      { label: 1, p: 0.9 }, // a
      { label: 2, p: 0.8 }, // b
    ]);
    const out = dec.decodeRow(t, 0);
    expect(out.text).toBe("ab");
    expect(out.confidence).toBeCloseTo(0.85, 6);
  });

  it("logs the layout exactly once, then stays silent", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const dec = createCtcDecoder(dict, { debug: true });
      const row = syntheticRow(1, 4, [{ label: 1, p: 0.9 }]);
      dec.decodeRow(row, 0);
      dec.decodeRow(row, 0);
      dec.decodeRow(row, 0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain("CTC layout");
    } finally {
      log.mockRestore();
    }
  });

  it("logs by default (diagnostics-on repo convention) and goes quiet with debug:false", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      createCtcDecoder(dict).decodeRow(syntheticRow(1, 4, [{ label: 1, p: 0.9 }]), 0);
      expect(log).toHaveBeenCalledTimes(1); // default ON
      createCtcDecoder(dict, { debug: false }).decodeRow(
        syntheticRow(1, 4, [{ label: 1, p: 0.9 }]),
        0,
      );
      expect(log).toHaveBeenCalledTimes(1); // still 1 — debug:false stays silent
    } finally {
      log.mockRestore();
    }
  });
});

describe("readingOrderSort", () => {
  const box = (x: number, y: number, w = 40, h = 12): TextBox => ({
    points: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  });

  it("restores top-to-bottom, left-to-right order from score-scrambled boxes", () => {
    // Detection returns score order: bullet (30) > title (100) > footnote (400).
    const title = box(50, 100);
    const bullet = box(10, 30);
    const sameLineRight = box(300, 102); // 2px below title → SAME visual line
    const footnote = box(20, 400);
    const sorted = readingOrderSort([footnote, sameLineRight, bullet, title]);
    expect(sorted).toEqual([bullet, title, sameLineRight, footnote]);
  });

  it("keeps a box 6px below on the NEXT line (>5px tolerance)", () => {
    const a = box(0, 100);
    const b = box(0, 106);
    expect(readingOrderSort([b, a])).toEqual([a, b]);
  });

  it("does not mutate the input array", () => {
    const input = [box(0, 50), box(0, 10)];
    const snapshot = [...input];
    readingOrderSort(input);
    expect(input).toEqual(snapshot);
  });
});

describe("quality gates", () => {
  it("minBoxSide returns the shortest bounding-rect side", () => {
    expect(minBoxSide(box4(0, 0, 100, 10))).toBe(10);
    expect(minBoxSide(box4(5, 5, 8, 90))).toBe(8);
  });

  it("minBoxSide keeps malformed/empty boxes (Infinity)", () => {
    expect(minBoxSide({ points: [] })).toBe(Infinity);
  });

  it("lengthWeightedConfidence weights by non-whitespace length", () => {
    const conf = lengthWeightedConfidence([
      { text: "hello", recConf: 0.9 }, // len 5
      { text: "hi", recConf: 0.6 }, // len 2
    ]);
    expect(conf).toBeCloseTo((0.9 * 5 + 0.6 * 2) / 7, 10);
  });

  it("lengthWeightedConfidence ignores whitespace in the weight", () => {
    expect(lengthWeightedConfidence([{ text: "a b", recConf: 1 }])).toBe(1); // len 2, conf 1
    expect(lengthWeightedConfidence([{ text: "  ", recConf: 1 }])).toBe(0); // zero weight
  });

  it("lengthWeightedConfidence treats missing recConf as 0 and empty set as 0", () => {
    expect(lengthWeightedConfidence([{ text: "x" }])).toBe(0);
    expect(lengthWeightedConfidence([])).toBe(0);
  });

  function box4(x: number, y: number, w: number, h: number): TextBox {
    return {
      points: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
    };
  }
});
