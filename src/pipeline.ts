import { decodeText, extractDocx, extractXlsx } from "./office.js";
import { extractPageText, loadPdf, nonWhitespaceLength } from "./pdf.js";
import { resolveOcr, resolveRaster } from "./runtime.js";
import { sniff } from "./sniff.js";
import type {
  DocKind,
  OcrEngine,
  Page,
  PageSource,
  ParseOptions,
  ParsedDocument,
  ParsedMeta,
  RasterAdapter,
  VlmGateway,
} from "./types.js";

const DEFAULTS = {
  maxBytes: 20 * 1024 * 1024, // 20 MB
  maxPages: 20, // OCR/VLM page budget
  maxChars: 50_000,
  perPageTimeoutMs: 30_000,
  nativeTextFloor: 8,
  ocrFloor: 3,
} as const;

/** Anything that can be turned into document bytes. `File` (browser) extends `Blob`. */
export type ParseInput = Uint8Array | ArrayBuffer | Blob;

/* --------------------------------- helpers -------------------------------- */

async function normalizeInput(
  input: ParseInput,
  opts: ParseOptions,
): Promise<{ bytes: Uint8Array; filename?: string; mime?: string }> {
  let bytes: Uint8Array;
  let filename = opts.filename;
  let mime = opts.mime;

  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    // Blob / File
    const ab = await input.arrayBuffer();
    bytes = new Uint8Array(ab);
    const file = input as Blob & { name?: string };
    if (!filename && typeof file.name === "string") filename = file.name;
    if (!mime && file.type) mime = file.type;
  }
  return { bytes, filename, mime };
}

function emptyResult(kind: DocKind, warnings: string[]): ParsedDocument {
  const meta: ParsedMeta = {
    pagesProcessed: 0,
    totalPages: 0,
    nativePages: 0,
    ocrPages: 0,
    vlmPages: 0,
    truncated: false,
    chars: 0,
  };
  return { text: "", source: "none", pages: [], warnings, kind, meta };
}

/** Race a promise against a per-page timeout and the caller's abort signal. */
function timed<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45)
    return "image/webp";
  return "image/png"; // generic default
}

/** Derive the document-level source from its pages' sources. */
function aggregateSource(pages: Page[]): ParsedDocument["source"] {
  const withText = pages.filter((p) => p.text.length > 0);
  if (withText.length === 0) return "none";
  const first = withText[0]!.source;
  return withText.every((p) => p.source === first) ? first : "mixed";
}

/**
 * Read an image (already-raster bytes) via OCR engine then VLM gateway.
 * Returns the chosen source and text, plus any warnings. Never throws for
 * content; only propagates abort.
 */
async function readImageBytes(
  bytes: Uint8Array,
  ctx: { pageIndex: number; totalPages: number; hint?: string; signal?: AbortSignal },
  opts: ParseOptions,
  ocr: OcrEngine,
  vlm: VlmGateway | undefined,
  perPageMs: number,
  warnings: string[],
): Promise<{ text: string; source: PageSource }> {
  const mime = detectImageMime(bytes);

  if (ocr.available) {
    try {
      const res = await timed(
        ocr.recognize(bytes, { ...ctx }),
        perPageMs,
        opts.signal ?? ctx.signal,
      );
      if ((res.text ?? "").trim().length >= (opts.ocrFloor ?? DEFAULTS.ocrFloor)) {
        return { text: res.text.trim(), source: "ocr" };
      }
      // OCR ran but produced too little → fall through to VLM.
    } catch (e) {
      if ((e as Error).message === "aborted") throw e;
      warnings.push(`ocr_error:page:${ctx.pageIndex}:${(e as Error).message}`);
    }
  }

  if (vlm) {
    try {
      const text = await timed(
        vlm.readImage(bytes, {
          pageIndex: ctx.pageIndex,
          totalPages: ctx.totalPages,
          hint: ctx.hint,
          mime,
          signal: opts.signal ?? ctx.signal,
        }),
        perPageMs,
        opts.signal ?? ctx.signal,
      );
      return { text: (text ?? "").trim(), source: "vlm" };
    } catch (e) {
      if ((e as Error).message === "aborted") throw e;
      warnings.push(`vlm_error:page:${ctx.pageIndex}:${(e as Error).message}`);
    }
  }

  if (!ocr.available && !vlm) {
    warnings.push(`ocr_unavailable:page:${ctx.pageIndex}: no OCR engine or VLM gateway configured`);
  }
  return { text: "", source: "native" };
}

/* ------------------------------- main entry ------------------------------- */

/**
 * Extract text from a document. Runs unchanged in the browser, Node, and Deno/edge.
 *
 * **Never throws for content problems** — an unparseable file returns
 * `{ text: "", warnings: [...] }`. Throws only on programmer error (bad input
 * type) or when the caller's abort signal fires / is already aborted.
 */
export async function parseDocument(
  input: ParseInput,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  if (input == null) throw new Error("parseDocument: input is required");
  if (options.signal?.aborted) throw new Error("aborted");

  const opts = options;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const maxPages = opts.maxPages ?? DEFAULTS.maxPages;
  const perPageMs = opts.perPageTimeoutMs ?? DEFAULTS.perPageTimeoutMs;
  const nativeFloor = opts.nativeTextFloor ?? DEFAULTS.nativeTextFloor;

  const { bytes, filename, mime } = await normalizeInput(input, opts);

  if (bytes.byteLength === 0) return emptyResult("other", ["empty_input"]);
  if (bytes.byteLength > maxBytes) {
    return emptyResult("other", [
      `input_too_large:${Math.round(bytes.byteLength / 1024)}KB_exceeds_${Math.round(maxBytes / 1024)}KB`,
    ]);
  }

  const { kind, warnings } = sniff({ bytes, filename, mime });

  switch (kind) {
    case "docx":
      return finishTextKind(kind, warnings, await safe(() => extractDocx(bytes), warnings, "docx"));
    case "xlsx":
      return finishTextKind(kind, warnings, safeSync(() => extractXlsx(bytes), warnings, "xlsx"));
    case "csv":
    case "text":
      return finishTextKind(kind, warnings, decodeText(bytes));
    case "image":
      return finishImageKind(bytes, opts, warnings, filename, maxPages, maxChars, perPageMs);
    case "pdf":
      return finishPdfKind(bytes, opts, warnings, filename, maxPages, maxChars, perPageMs, nativeFloor);
    default:
      warnings.push("unhandled_kind: no extractor for this document type");
      return emptyResult(kind, warnings);
  }
}

/* ---- per-kind finishers (build a ParsedDocument with truncation + meta) --- */

function finishTextKind(kind: DocKind, warnings: string[], text: string): ParsedDocument {
  const trimmed = (text ?? "").trim();
  const pages: Page[] = trimmed.length
    ? [{ index: 0, text: trimmed, source: "native" }]
    : [];
  const meta: ParsedMeta = {
    pagesProcessed: pages.length,
    totalPages: 1,
    nativePages: pages.length,
    ocrPages: 0,
    vlmPages: 0,
    truncated: false,
    chars: trimmed.length,
  };
  return { text: trimmed, source: pages.length ? "native" : "none", pages, warnings, kind, meta };
}

async function finishImageKind(
  bytes: Uint8Array,
  opts: ParseOptions,
  warnings: string[],
  filename: string | undefined,
  maxPages: number,
  maxChars: number,
  perPageMs: number,
): Promise<ParsedDocument> {
  const ocr = await resolveOcr(opts);
  const { text, source } = await readImageBytes(
    bytes,
    { pageIndex: 0, totalPages: 1, hint: filename, signal: opts.signal },
    opts,
    ocr,
    opts.vlm,
    perPageMs,
    warnings,
  );
  const pages: Page[] = text.length ? [{ index: 0, text, source }] : [];
  const meta: ParsedMeta = {
    pagesProcessed: 1,
    totalPages: 1,
    nativePages: source === "native" && text.length ? 1 : 0,
    ocrPages: source === "ocr" ? 1 : 0,
    vlmPages: source === "vlm" ? 1 : 0,
    truncated: false,
    chars: text.length,
  };
  // Respect maxChars even for a single image.
  const finalText = text.length > maxChars ? text.slice(0, maxChars) : text;
  if (text.length > maxChars) {
    warnings.push(`truncated_chars:${text.length}_to_${maxChars}`);
    meta.truncated = true;
    meta.chars = maxChars;
    if (pages[0]) pages[0]!.text = finalText;
  }
  return { text: finalText, source: pages.length ? source : "none", pages, warnings, kind: "image", meta };
}

async function finishPdfKind(
  bytes: Uint8Array,
  opts: ParseOptions,
  warnings: string[],
  filename: string | undefined,
  maxPages: number,
  maxChars: number,
  perPageMs: number,
  nativeFloor: number,
): Promise<ParsedDocument> {
  let doc;
  try {
    ({ doc } = await loadPdf(bytes, opts.pdfjs));
  } catch (e) {
    if ((e as Error).message === "aborted") throw e;
    warnings.push(`pdf_load_failed:${(e as Error).message}`);
    return emptyResult("pdf", warnings);
  }

  const raster: RasterAdapter = await resolveRaster(opts);
  const ocr: OcrEngine = await resolveOcr(opts);
  const totalPages = doc.numPages;

  const pages: Page[] = [];
  const counts = { native: 0, ocr: 0, vlm: 0 };
  let ocrBudget = maxPages; // shared across OCR + VLM
  let totalChars = 0;
  let truncated = false;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (opts.signal?.aborted) throw new Error("aborted");

    let pageText = "";
    let pageSource: PageSource = "native";

    try {
      const page = await doc.getPage(pageNum);
      const native = await extractPageText(page);

      if (nonWhitespaceLength(native) >= nativeFloor) {
        pageText = native;
        pageSource = "native";
        counts.native++;
      } else if (ocrBudget <= 0) {
        warnings.push(`ocr_budget_exhausted:page:${pageNum}: skipping (maxPages=${maxPages})`);
      } else if (!raster.available) {
        warnings.push(`raster_unavailable:page:${pageNum}: install a raster adapter to OCR scanned PDFs`);
      } else {
        // Rasterise then OCR → VLM fallback.
        let png: Uint8Array;
        try {
          png = await timed(
            raster.rasterizePdfPage(doc, pageNum - 1, { grayscale: true, normalize: true, maxEdge: 1600 }),
            perPageMs,
            opts.signal,
          );
        } catch (e) {
          if ((e as Error).message === "aborted") throw e;
          warnings.push(`raster_failed:page:${pageNum}:${(e as Error).message}`);
          png = new Uint8Array();
        }

        if (png.byteLength > 0) {
          const out = await readImageBytes(
            png,
            { pageIndex: pageNum - 1, totalPages, hint: filename, signal: opts.signal },
            opts,
            ocr,
            opts.vlm,
            perPageMs,
            warnings,
          );
          pageText = out.text;
          pageSource = out.source;
          if (pageText.length > 0) {
            ocrBudget--;
            if (out.source === "ocr") counts.ocr++;
            else if (out.source === "vlm") counts.vlm++;
          }
        }
      }
    } catch (e) {
      if ((e as Error).message === "aborted") throw e;
      warnings.push(`page_failed:${pageNum}:${(e as Error).message}`);
    }

    // Append page, respecting the global char cap.
    if (pageText.length > 0) {
      if (totalChars + pageText.length > maxChars) {
        const room = Math.max(0, maxChars - totalChars);
        pageText = pageText.slice(0, room);
        truncated = true;
        warnings.push(`truncated_chars:stopped_at_page:${pageNum}`);
        if (pageText.length > 0) pages.push({ index: pageNum - 1, text: pageText, source: pageSource });
        totalChars += pageText.length;
        break;
      }
      pages.push({ index: pageNum - 1, text: pageText, source: pageSource });
      totalChars += pageText.length;
    } else {
      pages.push({ index: pageNum - 1, text: "", source: "native" });
    }
  }

  if (counts.vlm > 0) warnings.push(`vlm_fallback_used:${counts.vlm}_pages`);

  const meta: ParsedMeta = {
    pagesProcessed: pages.length,
    totalPages,
    nativePages: counts.native,
    ocrPages: counts.ocr,
    vlmPages: counts.vlm,
    truncated,
    chars: totalChars,
  };
  const source = aggregateSource(pages);
  let text = pages
    .filter((p) => p.text.length > 0)
    .map((p) => p.text)
    .join("\n\n");
  // The page-separator joins can nudge output just past the cap; trim the final
  // string so the caller never receives more than maxChars.
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  meta.chars = text.length;

  return { text, source, pages, warnings, kind: "pdf", meta };
}

/* ------------------------------ small utils ------------------------------- */

async function safe<T>(
  fn: () => Promise<T>,
  warnings: string[],
  label: string,
): Promise<T | ""> {
  try {
    return await fn();
  } catch (e) {
    warnings.push(`${label}_failed:${(e as Error).message}`);
    return "";
  }
}

function safeSync<T>(fn: () => T, warnings: string[], label: string): T | "" {
  try {
    return fn();
  } catch (e) {
    warnings.push(`${label}_failed:${(e as Error).message}`);
    return "";
  }
}
