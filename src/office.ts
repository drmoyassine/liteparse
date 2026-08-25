import mammoth from "mammoth";
import * as XLSX from "xlsx";

/**
 * Office + tabular text extraction (isomorphic: pure JS via mammoth + SheetJS).
 *
 * - `.docx` → mammoth `extractRawText({ arrayBuffer })` — mammoth's BROWSER build
 *   (what the Web Worker bundles) honours ONLY `arrayBuffer` in `openZip`, NOT
 *   `buffer` (that's the Node build's `Buffer` reader). JSZip accepts the
 *   ArrayBuffer unchanged.
 * - `.xlsx` → SheetJS, every sheet rendered to CSV and concatenated with headers
 * - `.csv` / text → decoded as UTF-8 (CSV is returned as-is; the caller treats it as text)
 *
 * Legacy `.doc`/`.xls` never reach here — sniff reports them as `other`.
 */

/** Extract plain text from a `.docx`. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  // mammoth's two builds read DIFFERENT option keys in `openZip`:
  //   browser build → ONLY `arrayBuffer` (JSZip direct)
  //   Node build    → ONLY `path` | `buffer` | `file` (fed to JSZip.loadAsync,
  //                   which accepts Uint8Array/Buffer unchanged)
  // Passing `arrayBuffer` in Node throws "Could not find file in options" (the
  // 2026-08-25 regression: the browser fix at cbd689a broke Node — docx tests
  // fail in Node, exactly the runtime the parse runner uses); passing `buffer`
  // in the browser throws the same. Hand each build the key it reads.
  const isBrowser =
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined";
  const result = isBrowser
    ? await mammoth.extractRawText({ arrayBuffer: toArrayBuffer(bytes) })
    : // Typed as Buffer (Node-build .d.ts) but JSZip.loadAsync accepts any typed array.
      await mammoth.extractRawText({ buffer: bytes as unknown as Buffer });
  return result.value ?? "";
}

/** Slice a view's range out of its (possibly larger) backing buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // `bytes` may be a subarray of a larger transferred buffer, so `.buffer`
  // alone could carry trailing bytes. (The cast is honest — transferred
  // buffers are ArrayBuffers.)
  return (
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  ) as ArrayBuffer;
}

/** Extract a single string from an `.xlsx`, concatenating all sheets as CSV. */
export function extractXlsx(bytes: Uint8Array): string {
  const wb = XLSX.read(bytes, { type: "array" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (wb.SheetNames.length > 1) {
      parts.push(`# ${sheetName}`);
    }
    parts.push(csv);
  }
  return parts.join("\n").trim();
}

/** Decode a UTF-8 byte array to a string (for `.csv` / plain text). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
