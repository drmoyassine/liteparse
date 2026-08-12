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
  // mammoth's browser `openZip` honours ONLY an `arrayBuffer` key — passing
  // `{ buffer }` (the Node-build option) makes it find no recognised key and
  // throw "Could not find file in options" (docx bug 2026-08-12: xlsx worked,
  // docx didn't, because SheetJS.read takes a Uint8Array directly). JSZip accepts
  // the ArrayBuffer unchanged. Slice the view's range first: `bytes` may be a
  // subarray of a larger transferred buffer, so `.buffer` alone could carry
  // trailing bytes. (The cast is honest — transferred buffers are ArrayBuffers.)
  const arrayBuffer = (
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  ) as ArrayBuffer;
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value ?? "";
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
