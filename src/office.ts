import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { decodeWithDetection } from "./text/encoding.js";
import { mdHeading, mdTable } from "./formats/markdown.js";
import type { OfficeReadOptions } from "./formats/index.js";

/**
 * Office + tabular text extraction (isomorphic: pure JS via mammoth + SheetJS).
 *
 * - `.docx` → mammoth `extractRawText({ arrayBuffer })` — mammoth's BROWSER build
 *   (what the Web Worker bundles) honours ONLY `arrayBuffer` in `openZip`, NOT
 *   `buffer` (that's the Node build's `Buffer` reader). JSZip accepts the
 *   ArrayBuffer unchanged.
 * - `.xlsx` → SheetJS, every sheet rendered to CSV and concatenated with headers
 * - `.csv` / text → encoding detected first (UTF-8/BOM, UTF-16, windows-1256 /
 *   iso-8859-6 Arabic, windows-1252), so the spreadsheet reader sees correct text
 *
 * Other formats (pptx / ODF / rtf / doc / ppt / xls) live in ./formats/.
 */

/** Extract plain text (or Markdown) from a `.docx`. */
export async function extractDocx(bytes: Uint8Array, opts: OfficeReadOptions = {}): Promise<string> {
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
  const input = isBrowser
    ? { arrayBuffer: toArrayBuffer(bytes) }
    : // Typed as Buffer (Node-build .d.ts) but JSZip.loadAsync accepts any typed array.
      { buffer: bytes as unknown as Buffer };
  if (opts.structure === "markdown") {
    const toMd = (mammoth as unknown as { convertToMarkdown(i: typeof input): Promise<{ value?: string }> }).convertToMarkdown;
    const md = await toMd(input);
    return (md.value ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }
  const result = await mammoth.extractRawText(input);
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

/** Extract a single string from an `.xlsx`, concatenating all sheets as CSV (or Markdown tables). */
export function extractXlsx(bytes: Uint8Array, opts: OfficeReadOptions = {}): string {
  const wb = XLSX.read(bytes, { type: "array" });
  return renderWorkbook(wb, opts);
}

function renderWorkbook(wb: XLSX.WorkBook, opts: OfficeReadOptions): string {
  const md = opts.structure === "markdown";
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    if (wb.SheetNames.length > 1 || md) parts.push(md ? mdHeading(2, sheetName) : `# ${sheetName}`);
    if (md) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, raw: false, defval: "" });
      parts.push(mdTable(rows.map((r) => r.map((c) => String(c ?? "")))));
    } else {
      parts.push(XLSX.utils.sheet_to_csv(sheet, { blankrows: false }));
    }
  }
  return parts.join(md ? "\n\n" : "\n").trim();
}

/** Decode text bytes with encoding detection (for `.csv` / plain text). */
export function decodeText(bytes: Uint8Array): string {
  return decodeWithDetection(bytes).text;
}

/** CSV: decode with the detected encoding BEFORE SheetJS sees it, then render rows. */
export function extractCsv(bytes: Uint8Array, opts: OfficeReadOptions = {}): { text: string; encoding: string } {
  const { text, encoding } = decodeWithDetection(bytes);
  const wb = XLSX.read(text, { type: "string", raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0] ?? ""];
  if (!sheet) return { text: text.trim(), encoding };
  if (opts.structure === "markdown") {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, raw: false, defval: "" });
    return { text: mdTable(rows.map((r) => r.map((c) => String(c ?? "")))), encoding };
  }
  return { text: XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim(), encoding };
}
