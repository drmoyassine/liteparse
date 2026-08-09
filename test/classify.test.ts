/**
 * Tests for {@link classifyDocument}. PDFs are exercised by INJECTING a fake
 * pdfjs via {@link ClassifyOptions.pdfjs} — no real PDF fixtures required.
 */
import { describe, expect, it } from "vitest";
import { classifyDocument } from "../src/router/classify.js";
import { detectScript } from "../src/router/languages.js";
import type { PdfDocumentLike, PdfLibrary, PdfPageLike } from "../src/types.js";

// ─── fake pdfjs construction ─────────────────────────────────────────────────

/** Build a fake page whose text layer is a single string item. */
function fakePage(str: string): PdfPageLike {
  return {
    getTextContent: async () => ({ items: [{ str }] }),
    getViewport: () => ({ width: 612, height: 792 }),
    render: () => ({ promise: Promise.resolve() }),
  };
}

/** Build a fake PDF document; pages past `pageStrs.length` resolve to empty text. */
function fakeDoc(numPages: number, pageStrs: string[]): PdfDocumentLike {
  return {
    numPages,
    getPage: (n: number) => Promise.resolve(fakePage(pageStrs[n - 1] ?? "")),
  };
}

/** Fake pdfjs whose getDocument resolves to `doc`. */
function fakePdfjs(doc: PdfDocumentLike): PdfLibrary {
  return { getDocument: () => ({ promise: Promise.resolve(doc) }) };
}

/** Fake pdfjs whose getDocument throws synchronously (simulates a broken/missing lib). */
function throwingPdfjs(): PdfLibrary {
  return {
    getDocument: () => {
      throw new Error("pdfjs boom");
    },
  };
}

// ─── byte fixtures ───────────────────────────────────────────────────────────

function pdfMagic(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
}

function pngBytes(): Uint8Array {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const filler = Array.from({ length: 64 }, () => 0);
  return new Uint8Array([...magic, ...filler]);
}

// >100 non-whitespace chars on page 1 → digital.
const DIGITAL_TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(4);
// <10 non-whitespace chars → scanned.
const SCANNED_TEXT = "ab3";
// Between 10 and 100 non-whitespace chars → ambiguous.
const AMBIGUOUS_TEXT = "x".repeat(50);

// ─── cases ───────────────────────────────────────────────────────────────────

describe("classifyDocument", () => {
  it("classifies a digital PDF (text layer >=100 chars) as not scanned", async () => {
    const bytes = pdfMagic();
    const doc = fakeDoc(5, [DIGITAL_TEXT]);
    const profile = await classifyDocument(bytes, "report.pdf", {
      pdfjs: fakePdfjs(doc),
    });

    expect(profile.kind).toBe("pdf");
    expect(profile.pages).toBe(5);
    expect(profile.scanned).toBe(false);
    expect(profile.script).toBe(detectScript(DIGITAL_TEXT));
    expect(profile.bytes).toBe(bytes.byteLength);
    expect(profile.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/textLayer probe: \d+ chars on page 1/)]),
    );
  });

  it("classifies a scanned PDF (text layer <10 chars) as scanned", async () => {
    const bytes = pdfMagic();
    const doc = fakeDoc(3, [SCANNED_TEXT]);
    const profile = await classifyDocument(bytes, "scan.pdf", {
      pdfjs: fakePdfjs(doc),
    });

    expect(profile.kind).toBe("pdf");
    expect(profile.pages).toBe(3);
    expect(profile.scanned).toBe(true);
    expect(profile.script).toBe(detectScript(SCANNED_TEXT));
  });

  it("resolves an ambiguous first page by majority across probed pages", async () => {
    const bytes = pdfMagic();
    // page 1 ambiguous (50), pages 2–3 digital → digital wins 2–0.
    const doc = fakeDoc(3, [AMBIGUOUS_TEXT, DIGITAL_TEXT, DIGITAL_TEXT]);
    const profile = await classifyDocument(bytes, "mix.pdf", {
      pdfjs: fakePdfjs(doc),
    });

    expect(profile.kind).toBe("pdf");
    expect(profile.pages).toBe(3);
    expect(profile.scanned).toBe(false);
  });

  it("returns scanned=null when the ambiguous majority is a tie", async () => {
    const bytes = pdfMagic();
    // page 1 ambiguous (no vote), page 2 digital, page 3 scanned → 1–1 tie.
    const doc = fakeDoc(3, [AMBIGUOUS_TEXT, DIGITAL_TEXT, SCANNED_TEXT]);
    const profile = await classifyDocument(bytes, "tie.pdf", {
      pdfjs: fakePdfjs(doc),
    });

    expect(profile.scanned).toBeNull();
  });

  it("classifies a PNG image: pages 1, scanned null, script unknown", async () => {
    const bytes = pngBytes();
    const profile = await classifyDocument(bytes, "photo.png");

    expect(profile.kind).toBe("image");
    expect(profile.pages).toBe(1);
    expect(profile.scanned).toBeNull();
    expect(profile.script).toBe("unknown");
    expect(profile.bytes).toBe(bytes.byteLength);
  });

  it("classifies plain utf-8 text (by extension) and detects its script", async () => {
    const text = "Hello world, this is a plain text document for classification.";
    const bytes = new TextEncoder().encode(text);
    const profile = await classifyDocument(bytes, "notes.txt");

    expect(profile.kind).toBe("text");
    expect(profile.pages).toBe(1);
    expect(profile.scanned).toBeNull();
    expect(profile.script).toBe(detectScript(text));
  });

  it("does not throw when pdfjs fails; reports pdfjs_unavailable", async () => {
    const bytes = pdfMagic();
    const profile = await classifyDocument(bytes, "broken.pdf", {
      pdfjs: throwingPdfjs(),
    });

    expect(profile.kind).toBe("pdf");
    expect(profile.pages).toBe(0);
    expect(profile.scanned).toBeNull();
    expect(profile.script).toBe("unknown");
    expect(profile.notes).toEqual(expect.arrayContaining(["pdfjs_unavailable"]));
  });
});
