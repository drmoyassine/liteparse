import type { DocKind } from "./types.js";

export interface SniffInput {
  bytes?: Uint8Array;
  filename?: string;
  mime?: string;
}

export interface SniffResult {
  kind: DocKind;
  warnings: string[];
}

const MAGIC = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  png: [0x89, 0x50, 0x4e, 0x47], // ‰PNG
  jpg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38], // GIF8
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF (WebP container; confirm WEBP later)
  bmp: [0x42, 0x4d], // BM
  zip: [0x50, 0x4b, 0x03, 0x04], // PK..  (also 05 06 / 07 08)
  ole: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // legacy OLE2 (doc/xls/ppt)
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < sig.length + offset) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Best-effort decode of a slice of bytes as latin1 for substring inspection inside a ZIP. */
function containsAscii(bytes: Uint8Array, needle: string, scanLimit = 4096): boolean {
  const limit = Math.min(bytes.length, scanLimit);
  // Build the haystack only up to the scan limit (cheap-ish), then search.
  let haystack = "";
  for (let i = 0; i < limit; i++) haystack += String.fromCharCode(bytes[i]!);
  return haystack.includes(needle);
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]);
const TEXT_EXTS = new Set(["txt", "md", "markdown", "json", "xml", "html", "htm", "log", "csv"]);

function extOf(filename?: string): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

function mimeToKind(mime?: string): DocKind | undefined {
  if (!mime) return undefined;
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png" || mime === "image/jpeg" || mime.startsWith("image/")) return "image";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" // legacy doc — treated as other downstream, but signal docx-ish
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  )
    return "xlsx";
  if (mime === "text/csv") return "csv";
  if (mime.startsWith("text/")) return "text";
  return undefined;
}

/**
 * Determine the {@link DocKind} from magic bytes first, then extension, then mime.
 * Legacy `.doc`/`.xls` (OLE2 compound files) are reported as `other` with a warning,
 * because they cannot be parsed by the isomorphic office parsers.
 */
export function sniff({ bytes, filename, mime }: SniffInput): SniffResult {
  const warnings: string[] = [];

  if (bytes && bytes.length >= 4) {
    if (startsWith(bytes, MAGIC.pdf)) return { kind: "pdf", warnings };
    if (startsWith(bytes, MAGIC.png)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.jpg)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.gif)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.bmp)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.webp)) {
      // RIFF container: confirm WEBP at offset 8 to avoid classifying WAV as image.
      if (bytes.length >= 12 && containsAscii(bytes.subarray(0, 12), "WEBP"))
        return { kind: "image", warnings };
    }
    if (startsWith(bytes, MAGIC.ole)) {
      warnings.push("legacy_office_not_supported: legacy .doc/.xls/.ppt (OLE2) cannot be parsed; convert to .docx/.xlsx");
      return { kind: "other", warnings };
    }
    if (
      startsWith(bytes, MAGIC.zip) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
    ) {
      // OOXML is a ZIP. Disambiguate docx vs xlsx by peeking at internal entry names.
      const ext = extOf(filename);
      if (containsAscii(bytes, "word/document.xml")) return { kind: "docx", warnings };
      if (containsAscii(bytes, "xl/workbook.xml")) return { kind: "xlsx", warnings };
      // Fall back to extension for the OOXML family.
      if (ext === "xlsx") return { kind: "xlsx", warnings };
      if (ext === "docx") return { kind: "docx", warnings };
      // Unknown OOXML; prefer docx as a gentle default but flag it.
      warnings.push("ooxml_kind_ambiguous: ZIP/OOXML container could not be sub-typed; assuming docx");
      return { kind: "docx", warnings };
    }
  }

  // No reliable magic — use extension, then mime.
  const ext = extOf(filename);
  if (ext === "pdf") return { kind: "pdf", warnings };
  if (ext === "docx") return { kind: "docx", warnings };
  if (ext === "xlsx") return { kind: "xlsx", warnings };
  if (ext === "csv") return { kind: "csv", warnings };
  if (ext === "doc" || ext === "xls" || ext === "ppt") {
    warnings.push("legacy_office_not_supported: legacy .doc/.xls/.ppt cannot be parsed; convert to .docx/.xlsx");
    return { kind: "other", warnings };
  }
  if (IMAGE_EXTS.has(ext ?? "")) return { kind: "image", warnings };
  if (TEXT_EXTS.has(ext ?? "")) return { kind: ext === "csv" ? "csv" : "text", warnings };

  const byMime = mimeToKind(mime);
  if (byMime) return { kind: byMime, warnings };

  warnings.push("kind_unknown: could not determine document type");
  return { kind: "other", warnings };
}
