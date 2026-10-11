import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseDocument } from "../src/pipeline.js";
import { rebuildPageText } from "../src/pdf.js";
import { scoreTextLayer } from "../src/text/quality.js";
import { createDictionaryCheck } from "../src/text/dictionary.js";
import { detectEncoding, decodeWithDetection } from "../src/text/encoding.js";
import { sniff } from "../src/sniff.js";
import { decodeTiff, imageFormat } from "../src/image/convert.js";
import { extractRtf } from "../src/formats/rtf.js";
import { createRunnerOcrEngine, createVisionEndpointGateway } from "../src/ocr/remote.js";
import { createSharpRaster } from "../src/raster/sharp.js";
import type { OcrEngine, OcrResult, Page, RasterAdapter, VlmGateway } from "../src/types.js";

const fx = (p: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${p}`, import.meta.url)));

function engine(name: string, out: Partial<OcrResult> | ((ctx: Record<string, unknown>) => Partial<OcrResult>), extra: Partial<OcrEngine> = {}) {
  const recognize = vi.fn(async (_img: Uint8Array, ctx: Record<string, unknown>) => ({ text: "", ...(typeof out === "function" ? out(ctx) : out) }));
  return { name, available: true, recognize, ...extra } as OcrEngine & { recognize: typeof recognize };
}

const pngRaster: RasterAdapter = { name: "fake", runtime: "node", available: true, rasterizePdfPage: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };

/* ─────────────────────────────── line rebuilding ─────────────────────────────── */

describe("rebuildPageText — line breaks, spaces, paragraphs, hyphens, RTL", () => {
  const item = (str: string, x: number, y: number, w: number, extra: Record<string, unknown> = {}) => ({ str, transform: [12, 0, 0, 12, x, y], width: w, height: 12, ...extra });

  it("restores line breaks and word spaces that pdfjs items don't carry", () => {
    const t = rebuildPageText([item("Hello", 10, 700, 30), item("world", 44, 700, 30), item("next", 10, 686, 24), item("line", 36, 686, 22)]);
    expect(t).toBe("Hello world\nnext line");
  });

  it("uses hasEOL, puts blank lines between paragraphs, joins hyphenated words", () => {
    const t = rebuildPageText([
      item("The accredi-", 10, 700, 70, { hasEOL: true }),
      item("tation was granted.", 10, 686, 100),
      item("New paragraph.", 10, 640, 80),
    ]);
    expect(t).toBe("The accreditation was granted.\n\nNew paragraph.");
  });

  it("keeps Arabic (RTL) items in logical order", () => {
    const t = rebuildPageText([item("تقرير", 300, 700, 40, { dir: "rtl" }), item("الجودة", 240, 700, 50, { dir: "rtl" })]);
    expect(t).toBe("تقرير الجودة");
  });
});

/* ─────────────────────────────── quality + dictionary ─────────────────────────────── */

describe("text-layer quality check + optional dictionary", () => {
  it("passes clean text and flags replacement chars / symbols inside words / mojibake", () => {
    expect(scoreTextLayer("The accreditation standards were reviewed by the committee.").suspect).toBe(false);
    expect(scoreTextLayer("The acc\uFFFDed\uFFFDtation st\uFFFDndards").reasons[0]).toMatch(/^replacement_chars/);
    expect(scoreTextLayer("Acc#editation st@ndards a%e rev$ewed ann&ally b# the qu@lity").suspect).toBe(true);
    expect(scoreTextLayer("Ø§Ù„ØªÙ‚Ø±ÙŠØ± Ø§Ù„Ø³Ù†ÙˆÙŠ").suspect).toBe(true);
  });

  it("dictionary catches a letter swap the glyph check can't (flag only)", () => {
    const dict = createDictionaryCheck();
    expect(scoreTextLayer("The Accrtditation report").suspect).toBe(false);
    const r = dict.check("The Accrtditation report covers institutional programmes and committees");
    expect(r.flagged).toBe(true);
    expect(r.suspects).toEqual(["Accrtditation"]);
    expect(dict.check("Accreditation of the institutional programmes").flagged).toBe(false);
    expect(createDictionaryCheck().check("تقرير الاعتماد الأكاديمى").flagged).toBe(false); // ى/ي normalised
  });
});

/* ─────────────────────────────── per-page PDF cascade ─────────────────────────────── */

describe("per-page PDF cascade (real pdfjs, 141-page mixed fixture)", () => {
  it("OCRs only the 3 scanned pages, with real page numbers, methods and reasons", async () => {
    const ocr = engine("rapidocr-test", { text: "Scanned page of the self study", confidence: 0.95 });
    const delivered: Page[] = [];
    const doc = await parseDocument(fx("v06/mixed-141.pdf"), { filename: "m.pdf", raster: pngRaster, ocrEngine: ocr, onPage: (p) => delivered.push(p) });
    expect(ocr.recognize).toHaveBeenCalledTimes(3);
    expect(doc.pages).toHaveLength(141);
    expect(doc.source).toBe("mixed");
    expect(doc.meta).toMatchObject({ nativePages: 138, ocrPages: 3, totalPages: 141 });
    const ocrPages = doc.pages.filter((p) => p.method === "ocr");
    expect(ocrPages.map((p) => p.pageNumber)).toEqual([10, 70, 140]);
    expect(ocrPages.every((p) => p.reason === "scanned")).toBe(true);
    expect(doc.pages[0]!.text).toContain("institutional accreditation timeline");
    expect(doc.pages[0]!.text).toContain("\n\nSecond paragraph");
    expect(delivered.map((p) => p.pageNumber)).toEqual(Array.from({ length: 141 }, (_, i) => i + 1));
  });

  it("pageOutput 'single' merges into one entry with the same text", async () => {
    const ocr = engine("o", { text: "Scanned page text", confidence: 0.95 });
    const per = await parseDocument(fx("v06/mixed-141.pdf"), { raster: pngRaster, ocrEngine: ocr });
    const single = await parseDocument(fx("v06/mixed-141.pdf"), { raster: pngRaster, ocrEngine: ocr, pageOutput: "single" });
    expect(single.pages).toHaveLength(1);
    expect(single.text).toBe(per.text);
    expect(single.meta.ocrPages).toBe(3); // meta still reflects the per-page processing
  });

  it("the OCR budget counts OCR pages only, and a char cap stops reading with warnings", async () => {
    const ocr = engine("o", { text: "Scanned page text", confidence: 0.95 });
    const doc = await parseDocument(fx("v06/mixed-141.pdf"), { raster: pngRaster, ocrEngine: ocr, maxPages: 1 });
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
    expect(doc.meta.nativePages).toBe(138);
    expect(doc.pages[69]!.flags).toContain("ocr_skipped_budget:page_70");
    expect(doc.warnings).toContain("truncated_pages:ocr_budget_1");
    const capped = await parseDocument(fx("v06/mixed-141.pdf"), { raster: pngRaster, ocrEngine: ocr, maxChars: 1000 });
    expect(capped.warnings.some((w) => w.startsWith("truncated_pages:stopped_at_page_"))).toBe(true);
    expect(capped.warnings.some((w) => w.startsWith("truncated_chars:"))).toBe(true);
    expect(capped.text.length).toBe(1000);
  });

  it("flags scanned pages it cannot read instead of leaving them silently empty", async () => {
    const doc = await parseDocument(fx("v06/mixed-141.pdf"), { ocr: "off" });
    expect(doc.pages[9]!.flags).toContain("page_unread:page_10");
    expect(doc.warnings.some((w) => w.startsWith("raster_unavailable"))).toBe(true);
  });
});

describe("corrupted text layer", () => {
  it("re-reads a suspect page through the cascade and keeps the better version", async () => {
    const ocr = engine("o", { text: "Accreditation standards are reviewed annually by the quality committee", confidence: 0.95 });
    const doc = await parseDocument(fx("v06/corrupted-layer.pdf"), { raster: pngRaster, ocrEngine: ocr });
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
    expect(doc.pages[0]!.method).toBe("native");
    expect(doc.pages[1]).toMatchObject({ method: "ocr", reason: "text_layer_suspect" });
    expect(doc.pages[1]!.flags).toContain("text_layer_replaced:page_2");
  });

  it("keeps and flags the original text when no OCR or vision is available", async () => {
    const doc = await parseDocument(fx("v06/corrupted-layer.pdf"), { raster: pngRaster, ocr: "off" });
    expect(doc.pages[1]!.method).toBe("native");
    expect(doc.pages[1]!.text).toContain("Acc#editation");
    expect(doc.warnings).toContain("text_layer_suspect:page_2");
  });

  it("optional dictionary flags letter swaps on native pages (and can escalate)", async () => {
    const dictionary = createDictionaryCheck({ words: ["confirmed"] });
    const doc = await parseDocument(fx("v06/mixed-141.pdf"), { dictionary, ocr: "off" });
    expect(doc.warnings.some((w) => w.startsWith("dictionary_suspect"))).toBe(false);
    const swapped = { ...dictionary, check: () => ({ words: 9, suspects: ["Accrtditation"], flagged: true }), escalate: true };
    const ocr = engine("o", { text: "Reread text of the page", confidence: 0.95 });
    const d2 = await parseDocument(fx("v06/corrupted-layer.pdf"), { dictionary: swapped, raster: pngRaster, ocrEngine: ocr });
    expect(d2.pages[0]!.flags).toContain("dictionary_suspect:page_1");
    expect(ocr.recognize).toHaveBeenCalledTimes(2);
  });
});

/* ─────────────────────────────── Arabic / runner / vision ─────────────────────────────── */

describe("Arabic pages, browser → runner fallback, vision context", () => {
  it("a languageHint 'ar' sends scanned pages to an Arabic-capable engine with script=arabic", async () => {
    const ocr = engine("srv", { text: "تقرير الاعتماد", confidence: 0.95, script: "arabic" }, { scripts: ["latin", "arabic"] });
    await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { raster: pngRaster, ocrEngine: ocr, languageHint: "ar" });
    expect(ocr.recognize.mock.calls[0]![1]).toMatchObject({ script: "arabic", reason: "scanned" });
  });

  it("browser: Arabic pages skip the local Latin model and go to the runner", async () => {
    const local = engine("local-latin", { text: "garbage" });
    const runner = engine("runner", { text: "تقرير الاعتماد", confidence: 0.95, script: "arabic" }, { scripts: ["latin", "arabic"] });
    const doc = await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { raster: pngRaster, ocrEngine: local, runnerOcr: runner, languageHint: "ar" });
    expect(local.recognize).not.toHaveBeenCalled();
    expect(doc.pages[0]).toMatchObject({ engine: "runner", text: "تقرير الاعتماد" });
  });

  it("no runner: an Arabic page without a local model goes to vision with full context", async () => {
    const local = engine("local-latin", { text: "garbage" });
    const vlm: VlmGateway & { readImage: ReturnType<typeof vi.fn> } = { readImage: vi.fn(async () => "نص من الرؤية") };
    const doc = await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { filename: "scan.pdf", raster: pngRaster, ocrEngine: local, vlm, languageHint: "ar", requestId: "ams-42" });
    expect(local.recognize).not.toHaveBeenCalled();
    expect(doc.pages[0]).toMatchObject({ method: "vlm", reason: "arabic_no_local_model" });
    expect(vlm.readImage.mock.calls[0]![1]).toMatchObject({ pageNumber: 1, script: "arabic", language: "ar", reason: "arabic_no_local_model", documentName: "scan.pdf", requestId: "ams-42" });
  });

  it("dropped-box signal: a Latin read that dropped Arabic boxes is re-read with the Arabic engine and flagged", async () => {
    const local = engine("local", { text: "Annual report 2024", confidence: 0.95, totalBoxes: 4, droppedBoxes: 2, script: "latin" });
    const runner = engine("runner", { text: "Annual report 2024\nتقرير الجودة السنوي", confidence: 0.94, script: "arabic" });
    const doc = await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { raster: pngRaster, ocrEngine: local, runnerOcr: runner });
    expect(runner.recognize.mock.calls[0]![1]).toMatchObject({ script: "arabic" });
    expect(doc.pages[0]!.text).toContain("تقرير");
    expect(doc.pages[0]!.flags).toContain("ocr_dropped_script:page_1");
  });

  it("dropped-box signal without an Arabic engine falls to vision; keeps the partial read when vision is absent", async () => {
    const local = engine("local", { text: "Annual report 2024", confidence: 0.95, totalBoxes: 4, droppedBoxes: 2 });
    const vlm = { readImage: vi.fn(async () => "Annual report 2024 تقرير الجودة") };
    const viaVision = await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { raster: pngRaster, ocrEngine: local, vlm });
    expect(viaVision.pages[0]!.method).toBe("vlm");
    const partial = await parseDocument(fx("v06/mixed-en-ar-scan.pdf"), { raster: pngRaster, ocrEngine: local });
    expect(partial.pages[0]).toMatchObject({ method: "ocr", text: "Annual report 2024" });
    expect(partial.warnings).toContain("ocr_dropped_script:page_1");
  });

  it("runner + vision HTTP clients send base64 + context and never hold the runner key", async () => {
    const fetchMock = vi.fn(async (_u: string, init: { body: string }) => new Response(JSON.stringify({ text: "ok", script: "arabic", total_boxes: 3, dropped_boxes: 0 }), { status: 200 }));
    const runner = createRunnerOcrEngine({ url: "https://ams.example/runner-ocr", fetch: fetchMock as unknown as typeof fetch });
    const out = await runner.recognize(new Uint8Array([1, 2, 3]), { pageIndex: 4, totalPages: 9, script: "arabic", requestId: "r1" });
    expect(out).toMatchObject({ text: "ok", script: "arabic", totalBoxes: 3 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ data: "AQID", script: "arabic", pageNumber: 5, requestId: "r1" });
    const vision = createVisionEndpointGateway({ url: "https://ams.example/vision", fetch: fetchMock as unknown as typeof fetch });
    expect(await vision.readImage(new Uint8Array([1]), { pageNumber: 2, reason: "scanned" })).toBe("ok");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ image: "AQ==", pageNumber: 2, reason: "scanned" });
  });
});

/* ─────────────────────────────── formats ─────────────────────────────── */

describe("new formats (real files written by LibreOffice / python-pptx)", () => {
  const cases: Array<[string, string, string[]]> = [
    ["formats/deck.pptx", "pptx", ["Quality Overview\nGraduate outcomes improved\n\nNotes:\nSpeaker note one", "خطة التطوير\nSecond slide body"]],
    ["formats/deck.ppt", "ppt", ["Quality Overview\nGraduate outcomes improved\n\nNotes:\nSpeaker note one", "خطة التطوير\nSecond slide body"]],
    ["formats/deck.odp", "odp", ["Quality Overview\nGraduate outcomes improved\n\nNotes:\nSpeaker note one", "خطة التطوير\nSecond slide body"]],
  ];
  for (const [file, kind, pages] of cases) {
    it(`${kind}: one page per slide, speaker notes included`, async () => {
      const doc = await parseDocument(fx(file), { filename: file });
      expect(doc.kind).toBe(kind);
      expect(doc.pages.map((p) => p.text)).toEqual(pages);
      expect(doc.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
      expect(doc.warnings.some((w) => w.startsWith("legacy_office"))).toBe(false);
    });
  }

  for (const [file, kind] of [["formats/doc.doc", "doc"], ["formats/doc.odt", "odt"], ["formats/doc.rtf", "rtf"]] as const) {
    it(`${kind}: body text incl. Arabic and table cells`, async () => {
      const doc = await parseDocument(fx(file));
      expect(doc.kind).toBe(kind);
      expect(doc.text).toContain("Accreditation Report\nThe institution completed its self-study in 2024.");
      expect(doc.text).toContain("تقرير الاعتماد الأكاديمي للجامعة");
      expect(doc.text).toMatch(/Program\tStatus\s+Medicine\tAccredited/);
    });
  }

  for (const [file, kind] of [["formats/sheet.xls", "xls"], ["formats/sheet.ods", "ods"]] as const) {
    it(`${kind}: spreadsheet rows`, async () => {
      const doc = await parseDocument(fx(file));
      expect(doc.kind).toBe(kind);
      expect(doc.text).toBe("name,score\nAli,90\nMona,85");
    });
  }

  it("rtf: \\uN escapes and \\'hh bytes in an Arabic code page", () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset178 Arial;}}\f0 Hello \u1605?\u1585?\par\f1 \'c7\'e1\'d1\'ed\'c7\'d6\par}`;
    expect(extractRtf(new TextEncoder().encode(rtf)).pages[0]).toBe("Hello مر\nالرياض");
  });

  it("a picture-only deck (no text, embedded image) asks for conversion so its pictures get OCR'd", async () => {
    const doc = await parseDocument(fx("formats/picture-only.pptx"), { filename: "p.pptx" });
    expect(doc.warnings).toContain("needs_runner_conversion:pptx:empty");
  });

  it("an office file the readers can't handle asks for runner conversion, or converts via convertToPdf", async () => {
    const broken = fx("formats/deck.pptx").slice(0, 400); // truncated zip
    const noConv = await parseDocument(broken, { filename: "x.pptx" });
    expect(noConv.warnings.some((w) => w.startsWith("needs_runner_conversion:pptx"))).toBe(true);
    const convertToPdf = vi.fn(async () => fx("v06/corrupted-layer.pdf").slice());
    const conv = await parseDocument(broken, { filename: "x.pptx", convertToPdf });
    expect(convertToPdf).toHaveBeenCalled();
    expect(conv.warnings.some((w) => w.startsWith("converted_via_libreoffice:pptx"))).toBe(true);
    expect(conv.text).toContain("Page one has a clean text layer");
  });
});

/* ─────────────────────────────── csv encoding + images ─────────────────────────────── */

describe("encoding detection", () => {
  it("decodes a windows-1256 Arabic CSV before the spreadsheet reader", async () => {
    const doc = await parseDocument(fx("formats/ar1256.csv"), { filename: "a.csv" });
    expect(doc.text).toBe("name,city\nأحمد,الرياض\nSara,Jeddah");
    expect(doc.meta.encoding).toBe("windows-1256");
  });

  it("detects UTF-8 (+BOM), UTF-16 and the Latin fallback", () => {
    expect(detectEncoding(new TextEncoder().encode("مرحبا"))).toBe("utf-8");
    expect(decodeWithDetection(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ text: "A", encoding: "utf-8-bom" });
    expect(decodeWithDetection(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])).text).toBe("AB");
    expect(detectEncoding(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("windows-1252");
  });
});

describe("images: TIFF / BMP / GIF / WebP → PNG before OCR", () => {
  it("sniffs TIFF and decodes every frame in pure JS (browser path)", async () => {
    const tif = fx("v06/two-frames.tif");
    expect(sniff({ bytes: tif }).kind).toBe("image");
    expect(imageFormat(tif)).toBe("tiff");
    const frames = await decodeTiff(tif);
    expect(frames.map((f) => [f.width, f.height])).toEqual([[900, 300], [900, 300]]);
    expect(frames[0]!.data[0]).toBe(255); // white margin
  });

  it("sharp raster converts each format; a multi-page TIFF becomes one page per frame", async () => {
    const raster = await createSharpRaster();
    const seen: string[] = [];
    const ocr = engine("o", () => ({ text: "frame text read", confidence: 0.95 }));
    ocr.recognize.mockImplementation(async (img: Uint8Array) => {
      seen.push(imageFormat(img)!);
      return { text: "frame text read", confidence: 0.95 };
    });
    const tiff = await parseDocument(fx("v06/two-frames.tif"), { raster, ocrEngine: ocr });
    expect(tiff.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    for (const f of ["frame.bmp", "frame.gif", "frame.webp"]) await parseDocument(fx(`v06/${f}`), { raster, ocrEngine: ocr });
    expect(seen).toEqual(["png", "png", "png", "png", "png"]);
  });
});
