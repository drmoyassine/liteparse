import mammoth from "mammoth";
import * as XLSX from "xlsx";

/**
 * Office + tabular text extraction (isomorphic: pure JS via mammoth + SheetJS).
 *
 * - `.docx` → mammoth `extractRawText` (mammoth's `openZip` accepts a `buffer`
 *   option that it forwards to JSZip, which accepts a `Uint8Array` unchanged — no
 *   Node `Buffer` needed, so this works in the browser and Deno too)
 * - `.xlsx` → SheetJS, every sheet rendered to CSV and concatenated with headers
 * - `.csv` / text → decoded as UTF-8 (CSV is returned as-is; the caller treats it as text)
 *
 * Legacy `.doc`/`.xls` never reach here — sniff reports them as `other`.
 */

/** Extract plain text from a `.docx`. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  // mammoth's `openZip` only honours a `buffer` option (it forwards it to JSZip,
  // which accepts a `Uint8Array` unchanged). Its TypeScript types require a Node
  // `Buffer`; we cast because the runtime is Uint8Array-compatible and we want to
  // stay isomorphic (no Node `Buffer` in the browser/Deno).
  const result = await mammoth.extractRawText({ buffer: bytes as unknown as Buffer });
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
