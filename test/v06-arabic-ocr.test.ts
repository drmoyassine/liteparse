import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "../src/pipeline.js";
import { createSharpRaster } from "../src/raster/sharp.js";
import { createRapidOcrServerEngine, reverseArabic } from "../src/ocr/rapidocr-server.js";

/**
 * Real-model checks for the Arabic PP-OCRv5 recognition model inside the existing
 * RapidOCR server engine. Models are fetched by apps/runner/scripts/fetch-rapidocr-models.mjs;
 * the suite skips when they are absent (CI without network).
 */
const MODELS = new URL("../apps/runner/models/rapidocr/", import.meta.url).pathname;
const haveModels = existsSync(`${MODELS}arabic_PP-OCRv5_rec_mobile.onnx`) && existsSync(`${MODELS}en_PP-OCRv4_rec_infer.onnx`);
const fx = (p: string) => new Uint8Array(readFileSync(new URL(`./fixtures/v06/${p}`, import.meta.url)));

describe("reverseArabic (PaddleOCR pred_reverse)", () => {
  it("reverses visual-order Arabic while keeping Latin/digit runs intact", () => {
    expect(reverseArabic("ابc 2024")).toBe("c 2024با");
    expect(reverseArabic("Program 2024")).toBe("Program 2024");
  });
});

describe.skipIf(!haveModels)("RapidOCR server engine — Arabic model (real models)", () => {
  it("loads English + Arabic and reads an Arabic scan with script=arabic", async () => {
    const ocr = await createRapidOcrServerEngine({ modelPath: MODELS, debug: false });
    expect(ocr.scripts).toEqual(["latin", "arabic"]);
    const out = await ocr.recognize(fx("ar-scan.png"), { pageIndex: 0, totalPages: 1, script: "arabic" });
    expect(out.script).toBe("arabic");
    expect(out.text).toContain("تقرير الاعتماد الأكاديمي");
    expect(out.text).toContain("كلية الطب");
  }, 60_000);

  it("a mixed EN/AR scan keeps the English AND recovers the Arabic (no silent loss), flagged", async () => {
    const ocr = await createRapidOcrServerEngine({ modelPath: MODELS, debug: false });
    const raster = await createSharpRaster();
    const doc = await parseDocument(fx("mixed-en-ar-scan.pdf"), { raster, ocrEngine: ocr });
    const text = doc.pages[0]!.text;
    expect(text).toContain("Annual quality report 2024");
    expect(text).toContain("Program outcomes were measured");
    expect(text).toContain("تقرير الجودة السنوي");
    expect(doc.pages[0]!.flags).toContain("ocr_mixed_script:page_1");
    expect(doc.pages[0]!.script).toBe("mixed");
  }, 60_000);
});
