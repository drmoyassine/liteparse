import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "../src/pipeline.js";
import type { OcrEngine, PdfLibrary, RasterAdapter, VlmGateway } from "../src/types.js";
import { makeDocx } from "./helpers/zip.js";

/**
 * parseDocument is now router-driven (classify → route → execute). These tests
 * assert the *route actually taken* through injected fakes: a digital PDF never
 * reaches OCR; a scanned PDF does; office/text resolve natively; images cascade
 * OCR → VLM. Page counts are document-level for text engines (the router joins a
 * text layer into one page), so we assert source/engine/text, not legacy per-page
 * counts. See ROADMAP.md → Phase 3 (A10).
 */

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

function ocrEngine(text: string): OcrEngine & { recognize: ReturnType<typeof vi.fn> } {
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
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]);
// ≥100 non-whitespace chars on page 1 ⇒ classify marks the PDF digital (text layer).
const RICH = "word ".repeat(50);

/* ------------------------------- office/csv ------------------------------- */

describe("parseDocument — office & text", () => {
  it("extracts synthesised .docx natively", async () => {
    const res = await parseDocument(await makeDocx("Hello from a docx body."));
    expect(res.kind).toBe("docx");
    expect(res.text).toContain("Hello from a docx body.");
    expect(res.source).toBe("native");
  });

  it("reads csv via the spreadsheet extractor", async () => {
    const csv = new TextEncoder().encode("a,b\n1,2");
    const res = await parseDocument(csv, { filename: "data.csv" });
    expect(res.kind).toBe("csv");
    expect(res.text).toContain("a,b");
    expect(res.text).toContain("1,2");
    expect(res.source).toBe("native");
  });

  it("decodes plain text natively", async () => {
    const txt = new TextEncoder().encode("just some plain text here");
    const res = await parseDocument(txt, { filename: "notes.txt" });
    expect(res.kind).toBe("text");
    expect(res.source).toBe("native");
    expect(res.text).toContain("plain text");
  });

  it("routes unknown binary through best-effort text read (not empty)", async () => {
    // The router's default case is a best-effort text decode, so an opaque blob is
    // decoded rather than dropped — it yields native text (the consumer decides if
    // it's useful). Bytes 0x01–0x06 are non-whitespace, so they clear the floor.
    const res = await parseDocument(new Uint8Array([1, 2, 3, 4, 5, 6]), { filename: "blob.dat" });
    expect(res.kind).toBe("other");
    expect(res.source).toBe("native");
    expect(res.text.length).toBe(6);
  });
});

/* --------------------------------- images --------------------------------- */

describe("parseDocument — image OCR/VLM cascade", () => {
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

  it("returns an empty result when no OCR engine or VLM is configured", async () => {
    const res = await parseDocument(PNG, {});
    expect(res.text).toBe("");
    expect(res.source).toBe("none");
  });
});

/* ---------------------------------- PDFs ---------------------------------- */

describe("parseDocument — PDF routing (classify → route → execute)", () => {
  it("a digital PDF resolves via the text layer and NEVER touches OCR/VLM", async () => {
    const ocr = ocrEngine("should not run");
    const vlm = vlmGateway("should not run");
    const res = await parseDocument(PDF_MAGIC, {
      pdfjs: stubPdfjs([{ native: RICH }, { native: RICH }]),
      raster: stubRaster,
      ocrEngine: ocr,
      vlm,
    });
    expect(res.kind).toBe("pdf");
    expect(res.source).toBe("native");
    // The digital route is pdfjs-text only — the OCR chain is never even listed.
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(vlm.readImage).not.toHaveBeenCalled();
    expect(res.warnings.some((w) => w.includes("ocr") || w.includes("vlm"))).toBe(false);
  });

  it("a scanned PDF routes to OCR and recognises the rasterised page", async () => {
    const ocr = ocrEngine("OCR page text");
    const vlm = vlmGateway("fallback not needed");
    const res = await parseDocument(PDF_MAGIC, {
      pdfjs: stubPdfjs([{ native: "" }, { native: "" }]),
      raster: stubRaster,
      ocrEngine: ocr,
      vlm,
    });
    expect(res.source).toBe("ocr");
    expect(res.text).toContain("OCR page text");
    expect(ocr.recognize).toHaveBeenCalled();
    // OCR succeeded ⇒ the VLM last resort is never reached.
    expect(vlm.readImage).not.toHaveBeenCalled();
  });

  it("falls through OCR → VLM for a scanned PDF when OCR is unavailable", async () => {
    const vlm = vlmGateway("Scanned page text");
    const res = await parseDocument(PDF_MAGIC, {
      pdfjs: stubPdfjs([{ native: "" }, { native: "" }]),
      raster: stubRaster,
      vlm, // no ocrEngine ⇒ OCR leg unavailable
    });
    expect(res.source).toBe("vlm");
    expect(vlm.readImage).toHaveBeenCalled();
  });

  it("truncates native output at maxChars", async () => {
    const big = RICH + " " + "x".repeat(30000);
    const res = await parseDocument(PDF_MAGIC, {
      pdfjs: stubPdfjs([{ native: big }, { native: big }]),
      maxChars: 50000,
    });
    expect(res.meta.truncated).toBe(true);
    expect(res.meta.chars).toBe(50000);
    expect(res.text.length).toBe(50000);
  });

  it("returns an empty result when pdfjs cannot load the document", async () => {
    const broken: PdfLibrary = {
      getDocument: () => ({ promise: Promise.reject(new Error("boom")) }),
      GlobalWorkerOptions: {},
    };
    const res = await parseDocument(PDF_MAGIC, { pdfjs: broken });
    expect(res.text).toBe("");
    expect(res.source).toBe("none");
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

  it("throws a recognisable AbortError (name 'AbortError') on pre-abort", async () => {
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await parseDocument(PNG, { signal: ac.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });
});
