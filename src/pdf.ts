import type { PdfDocumentLike, PdfLibrary, PdfPageLike } from "./types.js";

/**
 * PDF handling via pdfjs-dist (optional peer). The library is loaded lazily so a
 * runtime that never touches PDFs pays nothing, and a runtime without pdfjs-dist
 * installed gets a clear warning instead of an import crash.
 *
 * Worker setup:
 *  - Browser: point `GlobalWorkerOptions.workerSrc` at a CDN copy matching the
 *    resolved version.
 *  - Node / Deno / injected instance: leave it to the caller / pdfjs defaults.
 */

let cachedLib: PdfLibrary | null = null;

function isBrowser(): boolean {
  return (
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

async function loadPdfjs(): Promise<PdfLibrary> {
  // pdfjs-dist is an optional peer — the dynamic import keeps it out of the main
  // bundle and out of runtimes that don't have it installed. We treat the module
  // loosely (`any`) because the real pdfjs types are stricter than our structural
  // PdfLibrary, but the runtime shapes are fully compatible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ "pdfjs-dist");
  // Modern v4 exposes getDocument on the namespace; some bundlers wrap it in .default.
  const candidate = mod?.getDocument ? mod : mod?.default ?? mod;
  const version: string | undefined = candidate?.version || mod?.version;
  const lib = candidate as PdfLibrary;
  if (isBrowser() && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version || "4.8.69"}/build/pdf.worker.min.mjs`;
  }
  return lib;
}

/** Resolve the pdfjs library, preferring an injected (already-configured) instance. */
export async function getPdfjs(injected?: PdfLibrary): Promise<PdfLibrary> {
  if (injected) return injected;
  if (cachedLib) return cachedLib;
  cachedLib = await loadPdfjs();
  return cachedLib;
}

/** Load a PDF document from bytes. */
export async function loadPdf(
  bytes: Uint8Array,
  pdfjs?: PdfLibrary,
): Promise<{ doc: PdfDocumentLike; lib: PdfLibrary }> {
  const lib = await getPdfjs(pdfjs);
  // pdfjs accepts a Uint8Array directly.
  const loadingTask = lib.getDocument({ data: bytes });
  const doc = await loadingTask.promise;
  return { doc, lib };
}

/** Join the text items of a page into a single, whitespace-normalised string. */
export async function extractPageText(page: PdfPageLike): Promise<string> {
  const content = await page.getTextContent();
  let raw = "";
  for (const item of content.items) {
    if (typeof item.str === "string") raw += item.str;
  }
  return raw.replace(/\s+/g, " ").trim();
}

/** Count non-whitespace characters — the heuristic for "does this page have real text". */
export function nonWhitespaceLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}
