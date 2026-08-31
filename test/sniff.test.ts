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

  it("detects WebP (RIFF…WEBP) and routes RIFF…WAVE to audio", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniff({ bytes: webp }).kind).toBe("image");
    // Track 3: WAV used to fall through to "other"; it is now a first-class
    // audio document (routes to STT).
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniff({ bytes: wav, filename: "song.wav" }).kind).toBe("audio");
    // A RIFF container that is neither WEBP nor WAVE (e.g. AVI) stays other.
    const riffOther = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
    expect(sniff({ bytes: riffOther }).kind).not.toBe("image");
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
    expect(sniff({ mime: "audio/webm" }).kind).toBe("audio");
  });

  it("returns other + warning when nothing resolves", () => {
    const res = sniff({ filename: "blob.dat" });
    expect(res.kind).toBe("other");
    expect(res.warnings.some((w) => w.startsWith("kind_unknown"))).toBe(true);
  });
});

describe("sniff audio (Track 3)", () => {
  it("detects WAV by RIFF…WAVE magic", () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniff({ bytes: wav }).kind).toBe("audio");
  });

  it("detects Ogg (OggS) and FLAC (fLaC)", () => {
    expect(sniff({ bytes: padded([0x4f, 0x67, 0x67, 0x53]) }).kind).toBe("audio");
    expect(sniff({ bytes: padded([0x66, 0x4c, 0x61, 0x43]) }).kind).toBe("audio");
  });

  it("detects MP3 via ID3 tag or bare MPEG frame sync", () => {
    expect(sniff({ bytes: padded([0x49, 0x44, 0x33, 0x04]) }).kind).toBe("audio");
    // 0xFF 0xFB = 11-bit MPEG frame sync; must not swallow JPEG (0xFF 0xD8…).
    expect(sniff({ bytes: padded([0xff, 0xfb, 0x90, 0x00]) }).kind).toBe("audio");
    expect(sniff({ bytes: padded([0xff, 0xd8, 0xff, 0xe0]) }).kind).toBe("image");
  });

  it("detects EBML/webm as audio only with an audio extension or an Opus track", () => {
    const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f]; // container header alone
    expect(sniff({ bytes: padded(ebml), filename: "note.webm" }).kind).toBe("audio");
    expect(sniff({ bytes: padded(ebml), filename: "rec.mka" }).kind).toBe("audio");
    // Opus track header in the first KB ⇒ audio even without a useful extension.
    const opus = bytes([...ebml, ...strBytes("OpusHead")]);
    expect(sniff({ bytes: opus, filename: "blob.bin" }).kind).toBe("audio");
    // Video webm (no audio signal, no audio extension) stays other.
    expect(sniff({ bytes: padded(ebml), filename: "clip.mkv" }).kind).toBe("other");
  });

  it("detects m4a via ftyp/M4A brand", () => {
    const m4a = bytes([...strBytes("\x00\x00\x00\x20ftypM4A "), 0, 0]);
    expect(sniff({ bytes: m4a, filename: "song.m4a" }).kind).toBe("audio");
  });

  it("falls back to audio extensions and audio/* mime", () => {
    expect(sniff({ filename: "voice.mp3" }).kind).toBe("audio");
    expect(sniff({ filename: "memo.wav" }).kind).toBe("audio");
    expect(sniff({ filename: "clip.opus" }).kind).toBe("audio");
    expect(sniff({ mime: "audio/mpeg" }).kind).toBe("audio");
  });
});

function strBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
