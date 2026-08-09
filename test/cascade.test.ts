import { describe, expect, it, vi } from "vitest";
import { parseWithFallbacks } from "../src/cascade.js";
import type { OcrEngine, WholeDocOcrProvider } from "../src/types.js";

/* ------------------------------- test stubs ------------------------------- */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // sniffed as "image"

function wholeDocProvider(name: string, text: string): WholeDocOcrProvider & {
  parseDoc: ReturnType<typeof vi.fn>;
} {
  return { name, parseDoc: vi.fn(async () => ({ text })) };
}

function pageEngine(name: string, text: string): OcrEngine & {
  recognize: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    available: true,
    recognize: vi.fn(async () => ({ text, confidence: 0.9 })),
  };
}

/* ----------------------------- cascade routing ---------------------------- */

describe("parseWithFallbacks — routing", () => {
  it("uses the whole-doc slot when it yields adequate text", async () => {
    const provider = wholeDocProvider("hosted-ocr", "hosted OCR result");
    const ocr = pageEngine("rapidocr", "SHOULD NOT BE USED");
    const res = await parseWithFallbacks(PNG, {
      filename: "scan.png",
      slots: [{ provider }],
      ocrEngine: ocr,
    });

    expect(res.text).toBe("hosted OCR result");
    expect(res.source).toBe("ocr");
    expect(res.engine).toBe("hosted-ocr");
    expect(provider.parseDoc).toHaveBeenCalledTimes(1);
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it("falls through to the page-image engine when the whole-doc result is weak", async () => {
    const provider = wholeDocProvider("hosted-ocr", "ab"); // < adequateChars (3)
    const ocr = pageEngine("rapidocr", "local OCR to the rescue");
    const res = await parseWithFallbacks(PNG, {
      filename: "img.png",
      slots: [{ provider }],
      ocrEngine: ocr,
    });

    expect(res.text).toBe("local OCR to the rescue");
    expect(res.source).toBe("ocr");
    expect(res.engine).toBe("rapidocr");
    expect(provider.parseDoc).toHaveBeenCalledTimes(1);
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
  });

  it("skips a slot whose `when` predicate is false", async () => {
    const provider = wholeDocProvider("hosted-ocr", "would be used but gated out");
    const ocr = pageEngine("rapidocr", "heavy path text");
    const res = await parseWithFallbacks(PNG, {
      filename: "img.png",
      slots: [{ provider, when: (i) => i.bytes.byteLength <= 1 }], // PNG is bigger → false
      ocrEngine: ocr,
    });

    expect(res.engine).toBe("rapidocr");
    expect(provider.parseDoc).not.toHaveBeenCalled();
  });

  it("falls through when a whole-doc provider throws (hosted blip is non-fatal)", async () => {
    const provider: WholeDocOcrProvider = {
      name: "hosted-ocr",
      parseDoc: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const ocr = pageEngine("rapidocr", "local still works");
    const res = await parseWithFallbacks(PNG, { slots: [{ provider }], ocrEngine: ocr });
    expect(res.engine).toBe("rapidocr");
    expect(res.text).toBe("local still works");
  });

  it("runs the heavy path with no slots and tags the engine from parseDocument", async () => {
    const ocr = pageEngine("rapidocr", "plain OCR text");
    const res = await parseWithFallbacks(PNG, { filename: "img.png", ocrEngine: ocr });
    expect(res.source).toBe("ocr");
    expect(res.engine).toBe("rapidocr");
  });
});

/* --------------------------- engine swappability -------------------------- */
/* The page-image OCR engine is a single injected slot: swapping it must be a
 * one-reference change with no pipeline edits. These two runs prove the cascade
 * uses whichever engine is handed to it and never reaches for a hardcoded one. */

describe("parseWithFallbacks — engine swappability", () => {
  it("uses engine A when A is injected, engine B when B is injected", async () => {
    const a = pageEngine("engine-a", "output from A");
    const aRun = await parseWithFallbacks(PNG, { ocrEngine: a });
    expect(aRun.engine).toBe("engine-a");
    expect(a.recognize).toHaveBeenCalledTimes(1);

    const b = pageEngine("engine-b", "output from B");
    const bRun = await parseWithFallbacks(PNG, { ocrEngine: b });
    expect(bRun.engine).toBe("engine-b");
    expect(b.recognize).toHaveBeenCalledTimes(1);
    // A is untouched on the B run — the engine is fully caller-controlled.
    expect(a.recognize).toHaveBeenCalledTimes(1);
  });

  it("swaps in a VLM-only config by omitting the page-image engine", async () => {
    const res = await parseWithFallbacks(PNG, {
      vlm: { readImage: vi.fn(async () => "VLM transcription") },
    });
    expect(res.source).toBe("vlm");
    expect(res.engine).toBe("vlm");
  });
});
