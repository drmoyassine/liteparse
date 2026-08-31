import { describe, expect, it } from "vitest";
import {
  STT_CONFIDENCE_FLOOR,
  greedyPick,
  logSumExp,
  sttFloorFor,
  tokenConfidence,
} from "../src/engines/moonshine/shared/confidence.js";
import type { Tokenizer } from "../src/engines/moonshine/shared/tokens.js";

/**
 * Hermetic confidence-math tests — the gate the whole STT cascade escalates on.
 * Token lengths below mirror a real decode: specials 0, words ~6 bytes.
 */

describe("logSumExp", () => {
  it("is ln Σe^x on small values", () => {
    expect(logSumExp([0, 0])).toBeCloseTo(Math.LN2, 10);
    expect(logSumExp([0, Math.log(3)])).toBeCloseTo(Math.log(4), 10);
  });

  it("stays finite on huge logits (max-shift stability)", () => {
    expect(logSumExp([1000, 1000])).toBeCloseTo(1000 + Math.LN2, 6);
    expect(logSumExp([-1e9, -1e9])).toBeCloseTo(-1e9 + Math.LN2, 3);
  });
});

describe("greedyPick", () => {
  it("picks the argmax and its true log-probability", () => {
    const { id, logProb } = greedyPick([0, 3, 1]);
    expect(id).toBe(1);
    expect(logProb).toBeCloseTo(3 - logSumExp([0, 3, 1]), 10);
    // Probability sums to 1 across picks by construction.
    expect(Math.exp(logProb)).toBeLessThan(1);
  });

  it("breaks ties toward the lower id", () => {
    expect(greedyPick([2, 2, 1]).id).toBe(0);
  });
});

describe("tokenConfidence", () => {
  // Stand-in tokenizer: specials and ST ids weigh 0, everything else its length.
  const tok: Pick<Tokenizer, "tokenLength"> = {
    tokenLength: (id) => (id <= 2 || id >= 100 ? 0 : 6),
  };

  it("is the plain geometric mean when all weights are equal", () => {
    const lp = Math.log(0.8);
    expect(tokenConfidence([lp, lp], tok, [12, 13])).toBeCloseTo(0.8, 10);
  });

  it("weights by byte length: a weak 1-byte token drags less than a weak word", () => {
    const strong = 0; // log-prob 1 → certain 6-byte word
    const weak = Math.log(0.25); // uncertain token
    const tokVar: Pick<Tokenizer, "tokenLength"> = {
      tokenLength: (id) => (id <= 2 ? 0 : id === 13 ? 1 : 6),
    };
    // Weak token 1 byte of 7 total: exp(ln(0.25)/7) — vs 0.5 if lengths were equal.
    expect(tokenConfidence([strong, weak], tokVar, [12, 13])).toBeCloseTo(0.25 ** (1 / 7), 10);
  });

  it("excludes specials entirely (weight 0)", () => {
    const lp = Math.log(0.5);
    // bos (id 1) carries no text: result is exactly the one real token's prob.
    expect(tokenConfidence([lp, lp], tok, [1, 12])).toBeCloseTo(0.5, 10);
  });

  it("returns 0 when every token is special (no text to be confident about)", () => {
    expect(tokenConfidence([Math.log(0.9), Math.log(0.9)], tok, [1, 2])).toBe(0);
  });
});

describe("floors", () => {
  it("defaults to the uncalibrated STT prior (0.55, NOT OCR's 0.85)", () => {
    expect(STT_CONFIDENCE_FLOOR).toBe(0.55);
    expect(sttFloorFor("moonshine-streaming-tiny-en")).toBe(0.55);
  });

  it("honors per-model overrides once stt-lab populates them", async () => {
    const { MODEL_STT_CONFIDENCE_FLOORS } = await import(
      "../src/engines/moonshine/shared/confidence.js"
    );
    MODEL_STT_CONFIDENCE_FLOORS["moonshine-batch-tiny-ar"] = 0.62;
    expect(sttFloorFor("moonshine-batch-tiny-ar")).toBe(0.62);
    delete MODEL_STT_CONFIDENCE_FLOORS["moonshine-batch-tiny-ar"];
  });
});
