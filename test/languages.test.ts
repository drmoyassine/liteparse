/**
 * Tests for src/router/languages.ts — script detection + the "Latin + 1 dynamic"
 * browser-language cap. Pure logic, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  LATIN,
  detectScript,
  decideBrowserLanguages,
  scriptToRecModel,
} from "../src/router/languages.js";

// ─── detectScript ───────────────────────────────────────────────────────────

describe("detectScript", () => {
  it("classifies plain English as latin", () => {
    expect(detectScript("Hello world")).toBe("latin");
  });

  it("classifies an Arabic sample as arabic", () => {
    expect(detectScript("السلام عليكم")).toBe("arabic");
  });

  it("classifies Russian Cyrillic as cyrillic", () => {
    expect(detectScript("Привет мир")).toBe("cyrillic");
  });

  it("classifies Japanese (kanji + katakana) as cjk", () => {
    expect(detectScript("日本語テスト")).toBe("cjk");
  });

  it("classifies Hindi Devanagari as devanagari", () => {
    expect(detectScript("नमस्ते")).toBe("devanagari");
  });

  it("returns unknown for the empty string", () => {
    expect(detectScript("")).toBe("unknown");
  });

  it("returns unknown when only digits and punctuation are present", () => {
    expect(detectScript("123 !!!")).toBe("unknown");
  });

  it("does not count digits or whitespace as latin", () => {
    // "123 456" has no letters at all → unknown, not latin.
    expect(detectScript("123 456")).toBe("unknown");
  });

  it("counts Latin-1 Supplement letters (diacritics) as latin", () => {
    expect(detectScript("café résumé naïve")).toBe("latin");
  });

  it("counts Latin Extended-A letters as latin", () => {
    // Latin Extended-A: ſ ł ŋ (U+017F, U+0142, U+014B).
    expect(detectScript("Aſ ł ŋ")).toBe("latin");
  });

  it("needs at least 2 non-latin chars to pick a non-latin script", () => {
    // A single Cyrillic character is not enough → falls back to latin (seen).
    expect(detectScript("Hello П")).toBe("latin");
    // Two Cyrillic characters with no Latin → cyrillic.
    expect(detectScript("При")).toBe("cyrillic");
  });

  it("prefers latin on a tie to avoid an unnecessary model load", () => {
    // "Hi" = 2 Latin; "Пя" = П, я = 2 Cyrillic → 2-2 tie → latin wins.
    expect(detectScript("Hi Пя")).toBe("latin");
  });

  it("picks the dominant non-latin family when it outweighs latin", () => {
    // 2 Latin ("Hi") vs several Arabic (العربية) → arabic dominates.
    expect(detectScript("Hi العربية")).toBe("arabic");
  });

  it("counts Hangul as cjk", () => {
    expect(detectScript("안녕하세요")).toBe("cjk");
  });

  it("counts Hiragana as cjk", () => {
    expect(detectScript("こんにちは")).toBe("cjk");
  });

  it("handles surrogate-pair astral characters without throwing", () => {
    // Emoji are astral (surrogate pairs); they don't count toward any family.
    // "A🎉B" → two Latin letters → latin; the emoji is ignored by code point.
    expect(detectScript("A🎉B")).toBe("latin");
  });
});

// ─── scriptToRecModel ───────────────────────────────────────────────────────

describe("scriptToRecModel", () => {
  it("maps latin → en", () => {
    expect(scriptToRecModel("latin")).toBe("en");
  });

  it("maps arabic → ar", () => {
    expect(scriptToRecModel("arabic")).toBe("ar");
  });

  it("maps cyrillic → ru", () => {
    expect(scriptToRecModel("cyrillic")).toBe("ru");
  });

  it("maps cjk → zh", () => {
    expect(scriptToRecModel("cjk")).toBe("zh");
  });

  it("maps devanagari → hi", () => {
    expect(scriptToRecModel("devanagari")).toBe("hi");
  });

  it("maps unknown → null", () => {
    expect(scriptToRecModel("unknown")).toBeNull();
  });

  it("maps other → null", () => {
    expect(scriptToRecModel("other")).toBeNull();
  });
});

// ─── decideBrowserLanguages (Latin + 1 dynamic cap) ────────────────────────

describe("decideBrowserLanguages", () => {
  it("loads a new non-latin script when only latin is cached", () => {
    expect(decideBrowserLanguages("cjk", ["latin"])).toEqual({
      load: ["cjk"],
      offloadToEdge: [],
    });
  });

  it("loads arabic and evicts the previous dynamic script (cjk)", () => {
    expect(decideBrowserLanguages("arabic", ["latin", "cjk"])).toEqual({
      load: ["arabic"],
      offloadToEdge: ["cjk"],
    });
  });

  it("does nothing when the detected script is latin", () => {
    expect(decideBrowserLanguages("latin", ["latin", "cjk"])).toEqual({
      load: [],
      offloadToEdge: [],
    });
  });

  it("does nothing when the detected script is already cached", () => {
    expect(decideBrowserLanguages("cjk", ["latin", "cjk"])).toEqual({
      load: [],
      offloadToEdge: [],
    });
  });

  it("does nothing when the detected script is unknown", () => {
    expect(decideBrowserLanguages("unknown", ["latin"])).toEqual({
      load: [],
      offloadToEdge: [],
    });
  });

  it("evicts ALL prior dynamic scripts when loading a new one", () => {
    // Defensive: even if the cache somehow held two dynamic scripts, both are
    // evicted so at most one non-latin script stays alongside Latin.
    const plan = decideBrowserLanguages("devanagari", ["latin", "cjk", "arabic"]);
    expect(plan.load).toEqual(["devanagari"]);
    expect(plan.offloadToEdge.sort()).toEqual(["arabic", "cjk"]);
  });

  it("never puts latin in offloadToEdge, in any case", () => {
    const cases: Parameters<typeof decideBrowserLanguages>[] = [
      ["latin", ["latin"]],
      ["unknown", ["latin", "cjk"]],
      ["cjk", ["latin"]],
      ["arabic", ["latin", "cjk"]],
      ["cjk", ["latin", "cjk"]],
      ["devanagari", ["latin", "arabic", "cyrillic"]],
    ];
    for (const [detected, cached] of cases) {
      const plan = decideBrowserLanguages(detected, cached);
      expect(plan.offloadToEdge).not.toContain("latin");
      expect(plan.load).not.toContain("latin");
    }
  });

  it("keeps at most one non-latin script in cache after applying the plan", () => {
    const plan = decideBrowserLanguages("arabic", ["latin", "cjk", "devanagari"]);
    // cache - offload + load should have exactly one non-latin script.
    const remaining = [...new Set(["latin", ...plan.load])].filter(
      (s) => !plan.offloadToEdge.some((o) => o === s),
    );
    const nonLatin = remaining.filter((s) => s !== "latin");
    expect(nonLatin).toEqual(["arabic"]);
  });
});

// ─── LATIN constant ─────────────────────────────────────────────────────────

describe("LATIN constant", () => {
  it("is the latin script", () => {
    expect(LATIN).toBe("latin");
  });
});
