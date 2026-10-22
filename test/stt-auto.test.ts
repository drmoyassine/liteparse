import { describe, expect, it, vi } from "vitest";
import { isDegenerate, pickAutoLanguage, transcribeAuto } from "../src/stt/auto.js";
import type { SttLanguage } from "../src/engines/moonshine/shared/models.js";
import type { SttResult } from "../src/types.js";

/**
 * The language:"auto" core (src/stt/auto.ts): the degeneracy detector, the
 * evidence pick, and the dual-decode orchestrator. These are the SAME rules
 * the runner's stt-service has run in production since the 2026-10-22 Arabic
 * fix — the engines (browser + server) now share them instead of defaulting
 * to "en". Hermetic: decode is a fake, no ort/models involved.
 */

const res = (text: string, confidence: number, language: SttLanguage): SttResult => ({
  text,
  confidence,
  language,
});

describe("isDegenerate — the repetition-loop signature", () => {
  it("short legit replies never trip it (even with repeats)", () => {
    expect(isDegenerate("yes yes I will send it")).toBe(false);
  });

  it("a ≥12-word loop with <35% unique words trips", () => {
    const loop = Array(10).fill("so i have a question").join(" "); // 50 words, 5 unique
    expect(isDegenerate(loop)).toBe(true);
  });

  it("long clean text does not trip", () => {
    expect(
      isDegenerate(
        "the university application deadline is next month and i still need help collecting my documents",
      ),
    ).toBe(false);
  });
});

describe("pickAutoLanguage", () => {
  it("Arabic script in the AR decode wins even when the EN decode is confident", () => {
    const pick = pickAutoLanguage(
      res("so i have a question about the university", 0.9, "en"),
      res("عندي سؤال عن الجامعة", 0.8, "ar"),
    );
    expect(pick.language).toBe("ar");
    expect(pick.reason).toContain("Arabic script in AR decode (EN 0.90, AR 0.80)");
  });

  it("EN repetition loop + clean AR (Latin) → ar", () => {
    const loop = Array(10).fill("so i have a question").join(" ");
    const pick = pickAutoLanguage(res(loop, 0.9, "en"), res("3andi sou2al 3an el jam3a", 0.7, "ar"));
    expect(pick.language).toBe("ar");
    expect(pick.reason).toContain("EN decode degenerate (repetition loop");
  });

  it("AR loop without Arabic script + clean EN → en", () => {
    const loop = Array(10).fill("salam salam salam").join(" ");
    const pick = pickAutoLanguage(res("hello there how are you doing today", 0.85, "en"), res(loop, 0.9, "ar"));
    expect(pick.language).toBe("en");
  });

  it("both decodes degenerate: higher confidence wins", () => {
    const enLoop = Array(10).fill("i have a question about").join(" ");
    const arLoop = Array(10).fill("salam alaikum salam alaikum").join(" ");
    const pick = pickAutoLanguage(res(enLoop, 0.4, "en"), res(arLoop, 0.75, "ar"));
    expect(pick).toMatchObject({ language: "ar" });
    expect(pick.reason).toContain("higher confidence wins (AR 0.75 vs EN 0.40)");
  });

  it("a slot that could not run loses to one that did", () => {
    expect(pickAutoLanguage(res("hello world", 0.9, "en"), null).reason).toBe("AR slot unavailable");
    expect(pickAutoLanguage(null, res("مرحبا", 0.9, "ar")).language).toBe("ar");
    expect(pickAutoLanguage(null, null)).toEqual({
      language: "en",
      reason: "no local slot-1 decode ran",
    });
  });

  it("both clean, no Arabic script → en (the status-quo default)", () => {
    const pick = pickAutoLanguage(res("hello there my friend", 0.9, "en"), res("hola mi amigo", 0.85, "ar"));
    expect(pick.language).toBe("en");
    expect(pick.reason).toContain("no Arabic script in AR decode");
  });
});

describe("transcribeAuto", () => {
  it("dual-decodes BOTH languages in parallel and normalizes the winner's language", async () => {
    const decoded: SttLanguage[] = [];
    const decode = vi.fn(async (language: SttLanguage) => {
      decoded.push(language);
      return language === "en"
        ? res("so i have a question about the university", 0.9, "en")
        : res("عندي سؤال عن الجامعة", 0.8, "ar");
    });
    const onPick = vi.fn();
    const result = await transcribeAuto(decode, { onPick });

    expect(decoded.sort()).toEqual(["ar", "en"]);
    expect(result).toMatchObject({ language: "ar", text: "عندي سؤال عن الجامعة" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ language: "ar" }));
  });

  it("a failing slot becomes null via onSlotError and the rules still pick", async () => {
    const onSlotError = vi.fn();
    const result = await transcribeAuto(async (language) => {
      if (language === "ar") throw new Error("model incomplete");
      return res("hello world how are you", 0.9, "en");
    }, { onSlotError });

    expect(result.language).toBe("en");
    expect(onSlotError).toHaveBeenCalledWith("ar", expect.any(Error));
  });

  it("both slots failing throws — the caller's failure contract is preserved", async () => {
    await expect(
      transcribeAuto(async () => {
        throw new Error("ort exploded");
      }),
    ).rejects.toThrow(/neither slot-1 decode ran/);
  });

  it("a pre-aborted signal throws before any decode", async () => {
    const decode = vi.fn(async () => res("x", 0.9, "en"));
    await expect(transcribeAuto(decode, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("a slot-internal abort rethrows instead of nulling the slot", async () => {
    const ctrl = new AbortController();
    await expect(
      transcribeAuto(async (language) => {
        if (language === "ar") {
          ctrl.abort(new Error("deadline exceeded"));
          throw new Error("deadline exceeded");
        }
        return res("hello", 0.9, "en");
      }, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
