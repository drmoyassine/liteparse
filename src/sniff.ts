import type { DocKind } from "./types.js";
import { legacyKind } from "./formats/legacy.js";

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
  ogg: [0x4f, 0x67, 0x67, 0x53], // OggS (vorbis/opus)
  flac: [0x66, 0x4c, 0x61, 0x43], // fLaC
  id3: [0x49, 0x44, 0x33], // ID3-tagged MP3
  ebml: [0x1a, 0x45, 0xdf, 0xa3], // EBML (webm/mka container)
  rtf: [0x7b, 0x5c, 0x72, 0x74, 0x66], // {\rtf
  tiffLE: [0x49, 0x49, 0x2a, 0x00], // II*.
  tiffBE: [0x4d, 0x4d, 0x00, 0x2a], // MM.*
};

/** ZIP entry names live in local headers (head) and the central directory (tail). */
function zipHas(bytes: Uint8Array, needle: string): boolean {
  if (containsAscii(bytes, needle, 8192)) return true;
  const tailStart = Math.max(0, bytes.length - 65536);
  return containsAscii(bytes.subarray(tailStart), needle, 65536);
}

const ODF_MIME: Record<string, DocKind> = {
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};
const EXT_KINDS: Record<string, DocKind> = {
  pdf: "pdf", docx: "docx", xlsx: "xlsx", csv: "csv", pptx: "pptx", odt: "odt", ods: "ods",
  odp: "odp", rtf: "rtf", doc: "doc", xls: "xls", ppt: "ppt",
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
const AUDIO_EXTS = new Set([
  "mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "wma", "aiff", "aif", "webm",
]);

function extOf(filename?: string): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

function mimeToKind(mime?: string): DocKind | undefined {
  if (!mime) return undefined;
  if (mime === "application/pdf") return "pdf";
  if (ODF_MIME[mime]) return ODF_MIME[mime];
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mime === "application/vnd.ms-powerpoint") return "ppt";
  if (mime === "application/rtf" || mime === "text/rtf") return "rtf";
  if (mime === "application/msword") return "doc";
  if (mime === "application/vnd.ms-excel") return "xls";
  if (mime === "image/png" || mime === "image/jpeg" || mime.startsWith("image/")) return "image";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "xlsx";
  if (mime === "text/csv") return "csv";
  if (mime.startsWith("text/")) return "text";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

/**
 * Determine the {@link DocKind} from magic bytes first, then extension, then mime.
 * Legacy OLE2 compound files are sub-typed (doc / xls / ppt) from their stream names.
 */
export function sniff({ bytes, filename, mime }: SniffInput): SniffResult {
  const warnings: string[] = [];

  if (bytes && bytes.length >= 4) {
    if (startsWith(bytes, MAGIC.pdf)) return { kind: "pdf", warnings };
    if (startsWith(bytes, MAGIC.png)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.jpg)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.gif)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.bmp)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.tiffLE) || startsWith(bytes, MAGIC.tiffBE)) return { kind: "image", warnings };
    if (startsWith(bytes, MAGIC.rtf)) return { kind: "rtf", warnings };

    // ── Audio containers (Track 3: audio documents route to STT). ──
    if (startsWith(bytes, MAGIC.ogg)) return { kind: "audio", warnings };
    if (startsWith(bytes, MAGIC.flac)) return { kind: "audio", warnings };
    // MP3: ID3v2 tag, or a bare MPEG frame sync (0xFF 0xE*). JPEG (0xFF 0xD8)
    // was already matched above, so the frame sync can't collide with it.
    if (startsWith(bytes, MAGIC.id3)) return { kind: "audio", warnings };
    if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
      return { kind: "audio", warnings };
    }
    // EBML (webm/mka container): audio only when the extension says audio/webm
    // or the stream carries an Opus track header — video webm stays "other".
    if (startsWith(bytes, MAGIC.ebml)) {
      const ext = extOf(filename);
      if (ext === "webm" || ext === "mka" || containsAscii(bytes, "OpusHead")) {
        return { kind: "audio", warnings };
      }
    }
    // ISO-BMFF audio (m4a): "ftyp" at offset 4 with an M4A brand at 8.
    if (
      bytes.length >= 12 &&
      containsAscii(bytes.subarray(4, 8), "ftyp") &&
      containsAscii(bytes.subarray(8, 12), "M4A ")
    ) {
      return { kind: "audio", warnings };
    }
    if (startsWith(bytes, MAGIC.webp)) {
      // RIFF container: confirm WEBP (image) or WAVE (audio) at offset 8.
      if (bytes.length >= 12 && containsAscii(bytes.subarray(0, 12), "WEBP"))
        return { kind: "image", warnings };
      // Track 3: WAV is a first-class audio document (routes to STT). Previously
      // fell through to "other".
      if (bytes.length >= 12 && containsAscii(bytes.subarray(0, 12), "WAVE"))
        return { kind: "audio", warnings };
    }
    if (startsWith(bytes, MAGIC.ole)) {
      const legacy = legacyKind(bytes);
      if (legacy) return { kind: legacy, warnings };
      const ext = extOf(filename);
      if (ext === "doc" || ext === "xls" || ext === "ppt") return { kind: ext, warnings };
      warnings.push("ole_kind_unknown: OLE2 compound file is not a Word/Excel/PowerPoint document");
      return { kind: "other", warnings };
    }
    if (
      startsWith(bytes, MAGIC.zip) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
    ) {
      // OOXML is a ZIP. Disambiguate docx vs xlsx by peeking at internal entry names.
      const ext = extOf(filename);
      for (const [m, k] of Object.entries(ODF_MIME)) {
        if (containsAscii(bytes, `mimetype${m}`, 512) || (ext === k && zipHas(bytes, "content.xml"))) return { kind: k, warnings };
      }
      if (zipHas(bytes, "word/document.xml")) return { kind: "docx", warnings };
      if (zipHas(bytes, "xl/workbook.xml")) return { kind: "xlsx", warnings };
      if (zipHas(bytes, "ppt/presentation.xml")) return { kind: "pptx", warnings };
      // Fall back to extension for the OOXML family.
      if (ext === "xlsx" || ext === "docx" || ext === "pptx") return { kind: ext, warnings };
      // Unknown OOXML; prefer docx as a gentle default but flag it.
      warnings.push("ooxml_kind_ambiguous: ZIP/OOXML container could not be sub-typed; assuming docx");
      return { kind: "docx", warnings };
    }
  }

  // No reliable magic — use extension, then mime.
  const ext = extOf(filename);
  if (ext && EXT_KINDS[ext]) return { kind: EXT_KINDS[ext]!, warnings };
  if (IMAGE_EXTS.has(ext ?? "")) return { kind: "image", warnings };
  if (AUDIO_EXTS.has(ext ?? "")) return { kind: "audio", warnings };
  if (TEXT_EXTS.has(ext ?? "")) return { kind: ext === "csv" ? "csv" : "text", warnings };

  const byMime = mimeToKind(mime);
  if (byMime) return { kind: byMime, warnings };

  warnings.push("kind_unknown: could not determine document type");
  return { kind: "other", warnings };
}
