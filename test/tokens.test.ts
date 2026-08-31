import { describe, expect, it } from "vitest";
import { loadTokenizer, stripTashkeel } from "../src/engines/moonshine/shared/tokens.js";

/**
 * Hermetic tokenizer tests on a hand-built mini vocab exercising every branch
 * the real (verified) Moonshine tokenizers share: SentencePiece specials,
 * `<0xNN>` byte fallback, U+2581 space markers, and out-of-vocab ids (the
 * streaming `<<ST_n>>` chunk markers).
 */

const TOKENIZER_JSON = {
  model: {
    vocab: {
      "<unk>": 0,
      "<s>": 1,
      "</s>": 2,
      "<0x41>": 10, // "A"
      "<0xD1>": 17, // first byte of UTF-8 "с"
      "<0x81>": 18, // second byte of UTF-8 "с"
      "▁hello": 12,
      "▁world": 13,
      "▁▁": 14, // a double-space piece
      "مرحبا": 15,
      "مُحَمَّد": 16,
    },
  },
};

describe("loadTokenizer", () => {
  it("rejects JSON without model.vocab", () => {
    expect(() => loadTokenizer({})).toThrowError(/missing model\.vocab/);
    expect(() => loadTokenizer({ model: {} })).toThrowError(/missing model\.vocab/);
  });

  it("rejects vocabs missing the SentencePiece specials 0/1/2", () => {
    expect(() => loadTokenizer({ model: { vocab: { "a": 1 } } })).toThrowError(/ids 0\/1\/2/);
  });
});

describe("Tokenizer.decodeIds", () => {
  const tok = loadTokenizer(TOKENIZER_JSON);

  it("reports vocabSize as maxId + 1 (excluding out-of-map ids)", () => {
    expect(tok.vocabSize).toBe(19);
  });

  it("skips specials and joins pieces with ▁ as space", () => {
    expect(tok.decodeIds([1, 12, 13, 2])).toBe("hello world");
  });

  it("decodes byte-fallback tokens through one UTF-8 pass", () => {
    // "A" + the two bytes of "с" (Cyrillic es) composing in the byte accumulator.
    expect(tok.decodeIds([10, 17, 18])).toBe("Aс");
  });

  it("preserves multi-space pieces (minus the sentencepiece-leading one)", () => {
    // "▁hello" + "▁▁" (2 spaces) + "▁world" → one leading space dropped, 3 kept.
    expect(tok.decodeIds([12, 14, 13])).toBe("hello   world");
  });

  it("skips ids at/above vocabSize (streaming ST markers) and unknown ids", () => {
    expect(tok.decodeIds([12, 32000, 32001, 13])).toBe("hello world");
    expect(tok.decodeIds([5])).toBe("");
  });

  it("decodes the empty sequence to empty text", () => {
    expect(tok.decodeIds([])).toBe("");
  });

  it("accepts bigint ids (decoder loops may carry them)", () => {
    expect(tok.decodeIds([12n, 13n])).toBe("hello world");
  });
});

describe("Tokenizer.tokenLength", () => {
  const tok = loadTokenizer(TOKENIZER_JSON);

  it("is 0 for specials (excluded from the confidence mean)", () => {
    expect(tok.tokenLength(0)).toBe(0);
    expect(tok.tokenLength(1)).toBe(0);
    expect(tok.tokenLength(2)).toBe(0);
  });

  it("counts decoded UTF-8 bytes (Arabic chars are 2 bytes each)", () => {
    expect(tok.tokenLength(12)).toBe(6); // "hello"
    expect(tok.tokenLength(15)).toBe(10); // "مرحبا" = 5 chars × 2 bytes
    expect(tok.tokenLength(17)).toBe(1); // single byte token
  });

  it("is 0 for out-of-range ids", () => {
    expect(tok.tokenLength(999)).toBe(0);
  });
});

describe("stripTashkeel", () => {
  it("strips harakat/tanween/shadda from fully vocalized text", () => {
    expect(stripTashkeel("مُحَمَّد")).toBe("محمد");
    expect(stripTashkeel("مَرْحَبًا")).toBe("مرحبا");
  });

  it("strips the superscript alef (U+0670)", () => {
    expect(stripTashkeel("هٰذا")).toBe("هذا");
  });

  it("keeps tatweel (a stretch, not a diacritic) and non-Arabic text", () => {
    expect(stripTashkeel("مـــا")).toBe("مـــا");
    expect(stripTashkeel("hello world")).toBe("hello world");
  });
});
