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

// ─── worker-safe canvas factory ──────────────────────────────────────────────
// pdfjs's default canvas factory (`DOMCanvasFactory`) resolves its `ownerDocument` to
// `globalThis.document` — which is UNDEFINED inside a DedicatedWorkerGlobalScope. So
// `page.render` of any page that needs an intermediate canvas (i.e. anything carrying an
// embedded image — a full-page scan is exactly that) throws "Cannot read properties of
// undefined (reading 'createElement')" before the OCR engine ever runs, surfacing in the
// cascade as "rapidocr: render failed (...) → engine: undefined, textLength: 0".
//
// HOW pdfjs accepts a factory (verified against pdfjs-dist@4.10.38's build): getDocument
// resolves `I = params.CanvasFactory || kt` (capital — a CONSTRUCTOR), then builds the
// instance itself with `new I({ ownerDocument, enableHWA })`. `render()` does NOT accept a
// factory override. So we must pass a CLASS under `CanvasFactory`, NOT an instance under
// `canvasFactory` (lowercase) — that key is never read and the default DOMCanvasFactory
// silently wins (an earlier attempt here made exactly that mistake). pdfjs exports no
// OffscreenCanvas factory and keeps `BaseCanvasFactory` private, so this class mirrors its
// 3-method surface (`create` / `reset` / `destroy` on `{ canvas, context }` records). It is
// passed in {@link loadPdf} ONLY when there's no `document` but `OffscreenCanvas` exists
// (a worker); the main thread keeps pdfjs's working default, Node keeps `NodeCanvasFactory`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCanvasRec = { canvas: any; context: any };

/**
 * `OffscreenCanvas`-backed canvas factory for pdfjs inside a Web Worker. Passed to
 * `getDocument` as the `CanvasFactory` constructor (capital). Mirrors pdfjs's internal
 * `BaseCanvasFactory` surface: `create` / `reset` / `destroy`. `ownerDocument` is passed
 * by pdfjs (undefined in a worker — the reason this class exists) and intentionally
 * ignored; intermediates are built with `OffscreenCanvas`, which needs no DOM.
 */
class OffscreenCanvasFactory {
  private readonly willReadFrequently: boolean;
  constructor(opts: { ownerDocument?: unknown; enableHWA?: boolean } = {}) {
    // Matches BaseCanvasFactory: willReadFrequently = !enableHWA. These intermediates are
    // read back during render (image processing), so the readback-friendly 2D context is
    // what we want by default (enableHWA=false).
    this.willReadFrequently = opts.enableHWA !== true;
  }
  create(width: number, height: number): AnyCanvasRec {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas;
    const canvas = new OffscreenCanvasCtor(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: this.willReadFrequently });
    return { canvas, context };
  }
  reset(existing: AnyCanvasRec, width: number, height: number): void {
    if (!existing.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    existing.canvas.width = width;
    existing.canvas.height = height;
  }
  destroy(existing: AnyCanvasRec): void {
    if (!existing.canvas) throw new Error("Canvas is not specified");
    existing.canvas.width = 0;
    existing.canvas.height = 0;
    existing.canvas = null;
    existing.context = null;
  }
}

/** Load a PDF document from bytes. */
export async function loadPdf(
  bytes: Uint8Array,
  pdfjs?: PdfLibrary,
): Promise<{ doc: PdfDocumentLike; lib: PdfLibrary }> {
  const lib = await getPdfjs(pdfjs);
  // pdfjs TRANSFERS the `data` buffer to its worker thread, detaching it in THIS thread.
  // Copy first so we never detach the caller's bytes — classifyDocument / executeRoute /
  // the worker all reuse the input after this returns (e.g. clientExtract hands the same
  // bytes to the OCR worker via .slice(), and base64-encodes the original for the edge
  // fallback). Without this copy those would throw "detached ArrayBuffer".
  const params: Record<string, unknown> = { data: bytes.slice() };
  // Inject the worker-safe factory precisely when pdfjs's DOM default is unavailable
  // (no `document`) but an `OffscreenCanvas` ctor exists. CAPITAL `CanvasFactory` — pdfjs
  // reads `params.CanvasFactory` (a constructor) and does `new I({ownerDocument, enableHWA})`;
  // a lowercase `canvasFactory` instance is never read. See OffscreenCanvasFactory above.
  if (
    typeof (globalThis as { document?: unknown }).document === "undefined" &&
    typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas !== "undefined"
  ) {
    params.CanvasFactory = OffscreenCanvasFactory;
  }
  const loadingTask = lib.getDocument(params);
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
