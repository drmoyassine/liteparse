import { describe, expect, it } from "vitest";
import { sniff } from "../src/sniff.js";

function bytes(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

/** Pad a magic prefix with zeros so it clears the 4-byte minimum. */
function padded(prefix: number[], total = 64): Uint8Array {
  const out = new Uint8Array(total);
  for (let i = 0; i < prefix.length; i++) out[i] = prefix[i]!;
  return out;
}

describe("sniff magic bytes", () => {
  it("detects PDF", () => {
    expect(sniff({ bytes: padded([0x25, 0x50, 0x44, 0x46]) }).kind).toBe("pdf");
  });

  it("detects PNG / JPEG / GIF / BMP", () => {
    expect(sniff({ bytes: padded([0x89, 0x50, 0x4e, 0x47]) }).kind).toBe("image");
    expect(sniff({ bytes: padded([0xff, 0xd8, 0xff, 0xe0]) }).kind).toBe("image");
    expect(sniff({ bytes: padded([0x47, 0x49, 0x46, 0x38]) }).kind).toBe("image");
    expect(sniff({ bytes: padded([0x42, 0x4d]) }).kind).toBe("image");
  });

  it("detects WebP (RIFF…WEBP) and ignores bare RIFF", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniff({ bytes: webp }).kind).toBe("image");
    const riffNotWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniff({ bytes: riffNotWebp, filename: "song.wav" }).kind).toBe("other");
  });

  it("detects OOXML docx vs xlsx by internal entry names", () => {
    const docx = bytes([0x50, 0x4b, 0x03, 0x04, ...strBytes("word/document.xml"), 0, 0]);
    const xlsx = bytes([0x50, 0x4b, 0x03, 0x04, ...strBytes("xl/workbook.xml"), 0, 0]);
    expect(sniff({ bytes: docx }).kind).toBe("docx");
    expect(sniff({ bytes: xlsx }).kind).toBe("xlsx");
  });

  it("falls back to extension for ambiguous OOXML", () => {
    const ooxml = padded([0x50, 0x4b, 0x03, 0x04]);
    expect(sniff({ bytes: ooxml, filename: "report.xlsx" }).kind).toBe("xlsx");
    expect(sniff({ bytes: ooxml, filename: "notes.docx" }).kind).toBe("docx");
    // No usable internal name AND no extension → docx default + warning.
    const res = sniff({ bytes: ooxml });
    expect(res.kind).toBe("docx");
    expect(res.warnings.some((w) => w.startsWith("ooxml_kind_ambiguous"))).toBe(true);
  });

  it("flags legacy OLE2 (.doc/.xls) as other with a warning", () => {
    const ole = padded([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const res = sniff({ bytes: ole, filename: "old.doc" });
    expect(res.kind).toBe("other");
    expect(res.warnings.some((w) => w.startsWith("legacy_office_not_supported"))).toBe(true);
  });

  it("uses extension when no magic is present", () => {
    expect(sniff({ filename: "data.csv" }).kind).toBe("csv");
    expect(sniff({ filename: "readme.md" }).kind).toBe("text");
    expect(sniff({ filename: "photo.PNG" }).kind).toBe("image");
    expect(sniff({ filename: "mystery.doc" }).kind).toBe("other");
  });

  it("uses mime when neither magic nor extension resolve", () => {
    expect(sniff({ mime: "application/pdf" }).kind).toBe("pdf");
    expect(sniff({ mime: "image/jpeg" }).kind).toBe("image");
    expect(sniff({ mime: "text/csv" }).kind).toBe("csv");
    expect(sniff({ mime: "text/plain" }).kind).toBe("text");
  });

  it("returns other + warning when nothing resolves", () => {
    const res = sniff({ filename: "blob.dat" });
    expect(res.kind).toBe("other");
    expect(res.warnings.some((w) => w.startsWith("kind_unknown"))).toBe(true);
  });
});

function strBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
