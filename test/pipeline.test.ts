import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "../src/pipeline.js";
import type { OcrEngine, PdfLibrary, RasterAdapter, VlmGateway } from "../src/types.js";
import { makeDocx } from "./helpers/zip.js";

/* ------------------------------- test stubs ------------------------------- */

function stubPdfjs(pages: { native: string }[]): PdfLibrary {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (n: number) =>
          Promise.resolve({
            getTextContent: () =>
              Promise.resolve({
                items: pages[n - 1]!.native.split(/(\s+)/).map((s) => ({ str: s })),
              }),
            getViewport: () => ({ width: 100, height: 100 }),
            render: () => ({ promise: Promise.resolve() }),
          }),
      }),
    }),
    GlobalWorkerOptions: {},
  };
}

const stubRaster: RasterAdapter = {
  name: "stub",
  runtime: "node",
  available: true,
  async rasterizePdfPage() {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG-ish bytes
  },
};

function ocrEngine(text: string): OcrEngine {
  return {
    name: "stub-ocr",
    available: true,
    recognize: vi.fn(async () => ({ text, confidence: 0.9 })),
  };
}

function vlmGateway(text: string): VlmGateway & { readImage: ReturnType<typeof vi.fn> } {
  return { readImage: vi.fn(async () => text) };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LONG = "Word ".repeat(4).trim(); // >8 non-whitespace chars → counts as native text

/* ------------------------------- office/csv ------------------------------- */

describe("parseDocument — office & text", () => {
  it("extracts synthesised .docx", async () => {
    const res = await parseDocument(await makeDocx("Hello from a docx body."));
    expect(res.kind).toBe("docx");
    expect(res.text).toContain("Hello from a docx body.");
    expect(res.source).toBe("native");
  });

  it("decodes csv/text bytes", async () => {
    const csv = new TextEncoder().encode("a,b\n1,2");
    const res = await parseDocument(csv, { filename: "data.csv" });
    expect(res.kind).toBe("csv");
    expect(res.text).toBe("a,b\n1,2");
    expect(res.source).toBe("native");
  });

  it("returns empty + warning for unhandled kinds", async () => {
    const res = await parseDocument(new Uint8Array([1, 2, 3, 4, 5, 6]), { filename: "blob.dat" });
    expect(res.text).toBe("");
    expect(res.warnings.some((w) => w.startsWith("unhandled_kind"))).toBe(true);
  });
});

/* --------------------------------- images --------------------------------- */

describe("parseDocument — image OCR/VLM", () => {
  it("uses OCR when available and sufficient, skipping VLM", async () => {
    const vlm = vlmGateway("SHOULD NOT BE USED");
    const res = await parseDocument(PNG, { ocrEngine: ocrEngine("Recognised image text"), vlm });
    expect(res.source).toBe("ocr");
    expect(res.text).toBe("Recognised image text");
    expect(vlm.readImage).not.toHaveBeenCalled();
  });

  it("falls back to VLM when OCR output is below the floor", async () => {
    const vlm = vlmGateway("VLM transcription result");
    const res = await parseDocument(PNG, { ocrEngine: ocrEngine("ab"), vlm }); // "ab" < floor 3
    expect(res.source).toBe("vlm");
    expect(res.text).toBe("VLM transcription result");
  });

  it("uses VLM directly when no OCR engine is configured", async () => {
    const vlm = vlmGateway("VLM only text");
    const res = await parseDocument(PNG, { vlm });
    expect(res.source).toBe("vlm");
    expect(vlm.readImage).toHaveBeenCalledTimes(1);
  });

  it("warns and returns empty when neither OCR nor VLM is available", async () => {
    const res = await parseDocument(PNG, {});
    expect(res.text).toBe("");
    expect(res.warnings.some((w) => w.startsWith("ocr_unavailable"))).toBe(true);
  });
});

/* ---------------------------------- PDFs ---------------------------------- */

describe("parseDocument — PDF", () => {
  it("extracts native text and never calls VLM", async () => {
    const vlm = vlmGateway("nope");
    const res = await parseDocument(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]),
      {
        pdfjs: stubPdfjs([{ native: "Page one has enough native text inside" }, { native: "Page two also native here" }]),
        vlm,
      },
    );
    expect(res.kind).toBe("pdf");
    expect(res.source).toBe("native");
    expect(res.meta.nativePages).toBe(2);
    expect(vlm.readImage).not.toHaveBeenCalled();
  });

  it("rasterises + VLMs scanned pages when OCR is unavailable", async () => {
    const vlm = vlmGateway("Scanned page text");
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: "" }, { native: "" }]),
      raster: stubRaster,
      vlm,
    });
    expect(res.source).toBe("vlm");
    expect(res.meta.vlmPages).toBe(2);
    expect(vlm.readImage).toHaveBeenCalledTimes(2);
    expect(res.warnings.some((w) => w.startsWith("vlm_fallback_used"))).toBe(true);
  });

  it("uses OCR engine on rasterised pages, with VLM as fallback only", async () => {
    const vlm = vlmGateway("fallback");
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: "" }]),
      raster: stubRaster,
      ocrEngine: ocrEngine("OCR page text"),
      vlm,
    });
    expect(res.source).toBe("ocr");
    expect(vlm.readImage).not.toHaveBeenCalled();
  });

  it("reports raster_unavailable for scanned pages with no raster adapter", async () => {
    const vlm = vlmGateway("x");
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: "" }]),
      vlm, // present but unreachable without a rasterizer
    });
    expect(res.source).toBe("none");
    expect(res.warnings.some((w) => w.startsWith("raster_unavailable"))).toBe(true);
    expect(vlm.readImage).not.toHaveBeenCalled();
  });

  it("tags a mixed native + scanned document as 'mixed'", async () => {
    const vlm = vlmGateway("scanned text");
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: "Page one has enough native text inside" }, { native: "" }]),
      raster: stubRaster,
      vlm,
    });
    expect(res.source).toBe("mixed");
    expect(res.meta.nativePages).toBe(1);
    expect(res.meta.vlmPages).toBe(1);
  });

  it("respects the maxPages OCR/VLM budget", async () => {
    const vlm = vlmGateway("page");
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: "" }, { native: "" }, { native: "" }, { native: "" }, { native: "" }, { native: "" }]),
      raster: stubRaster,
      vlm,
      maxPages: 3,
    });
    expect(vlm.readImage).toHaveBeenCalledTimes(3);
    expect(res.meta.vlmPages).toBe(3);
    expect(res.warnings.some((w) => w.startsWith("ocr_budget_exhausted"))).toBe(true);
  });

  it("truncates native output at maxChars", async () => {
    const big = LONG + " " + "x".repeat(30000);
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), {
      pdfjs: stubPdfjs([{ native: big }, { native: big }]),
      maxChars: 50000,
    });
    expect(res.meta.truncated).toBe(true);
    expect(res.meta.chars).toBe(50000);
    expect(res.text.length).toBe(50000);
  });

  it("records pdf_load_failed when pdfjs cannot load", async () => {
    const broken: PdfLibrary = {
      getDocument: () => ({ promise: Promise.reject(new Error("boom")) }),
      GlobalWorkerOptions: {},
    };
    const res = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]), { pdfjs: broken });
    expect(res.text).toBe("");
    expect(res.warnings.some((w) => w.startsWith("pdf_load_failed"))).toBe(true);
  });
});

/* --------------------------------- limits --------------------------------- */

describe("parseDocument — limits & abort", () => {
  it("returns empty + warning when input exceeds maxBytes", async () => {
    const res = await parseDocument(new Uint8Array(200), { maxBytes: 100 });
    expect(res.text).toBe("");
    expect(res.warnings.some((w) => w.startsWith("input_too_large"))).toBe(true);
  });

  it("returns empty + warning for zero-length input", async () => {
    const res = await parseDocument(new Uint8Array(0));
    expect(res.text).toBe("");
    expect(res.warnings).toContain("empty_input");
  });

  it("throws on programmer error (null input)", async () => {
    await expect(parseDocument(null as unknown as Uint8Array)).rejects.toThrow("required");
  });

  it("throws when the abort signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(parseDocument(PNG, { signal: ac.signal })).rejects.toThrow("aborted");
  });
});
