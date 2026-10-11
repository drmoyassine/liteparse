/**
 * Text-encoding detection for csv / txt / rtf inputs, so Arabic files saved in
 * Windows code pages don't decode to mojibake. Order: BOM → UTF-16 heuristic →
 * strict UTF-8 → Arabic single-byte (windows-1256 / iso-8859-6) → windows-1252.
 */

export type DetectedEncoding =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16be"
  | "windows-1256"
  | "iso-8859-6"
  | "windows-1252";

const SAMPLE = 64 * 1024;

function isArabicLetter(cp: number): boolean {
  return (cp >= 0x621 && cp <= 0x64a) || (cp >= 0x671 && cp <= 0x6d3) || cp === 0x67e || cp === 0x686 || cp === 0x698 || cp === 0x6af;
}

/** Share of non-ASCII chars in `text` that are Arabic letters (0 below 3 letters — too little evidence). */
function arabicShare(text: string): number {
  let high = 0;
  let ar = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) continue;
    high++;
    if (isArabicLetter(cp)) ar++;
  }
  return ar < 3 ? 0 : ar / high;
}

function safeDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return null; // label unsupported in this runtime (small-ICU builds)
  }
}

function utf16Guess(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(bytes.length, SAMPLE) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return "utf-16le";
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return "utf-16be";
  return null;
}

/** Detect the encoding of a text file. */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8-bom";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const u16 = utf16Guess(bytes);
  if (u16) return u16;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    // not valid UTF-8 → single-byte code page
  }
  const sample = bytes.subarray(0, SAMPLE);
  const w1256 = safeDecode("windows-1256", sample);
  const iso6 = safeDecode("iso-8859-6", sample);
  const s1256 = w1256 ? arabicShare(w1256) : 0;
  const sIso = iso6 && !iso6.includes("\uFFFD") ? arabicShare(iso6) : 0;
  if (Math.max(s1256, sIso) >= 0.5) return sIso > s1256 ? "iso-8859-6" : "windows-1256";
  return "windows-1252";
}

/** Decode text bytes with the detected encoding (BOM stripped). */
export function decodeWithDetection(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  const encoding = detectEncoding(bytes);
  const label = encoding === "utf-8-bom" ? "utf-8" : encoding;
  const text = safeDecode(label, bytes) ?? new TextDecoder("utf-8").decode(bytes);
  return { text: text.replace(/^\uFEFF/, ""), encoding };
}

/** Map a Windows code page number (RTF \ansicpg / \fcharset) to a TextDecoder label. */
export function codePageLabel(cp: number): string {
  if (cp === 65001) return "utf-8";
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  switch (cp) {
    case 874:
      return "windows-874";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    case 10000:
      return "macintosh";
    case 708:
      return "iso-8859-6";
    default:
      return "windows-1252";
  }
}

/** Decode single-byte bytes with a code page label, falling back to windows-1252. */
export function decodeCodePage(bytes: Uint8Array, label: string): string {
  return safeDecode(label, bytes) ?? safeDecode("windows-1252", bytes) ?? "";
}
