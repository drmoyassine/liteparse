/**
 * executeRoute — the pure, fully unit-tested core of the router's executor.
 *
 * 0.6.0: PDFs and images are processed **one page at a time** through the existing
 * cascade (pdfjs text → RapidOCR → Granite-Docling → vision). A page leaves the native
 * path only when its own text is missing or fails the quality check, and only that
 * page is rendered. Office/text documents run their document-level extractor; office
 * files that under-read can be converted to PDF (runner LibreOffice) and re-enter the
 * per-page path. Every dep is injected, so the core is tested with fakes.
 */
import type { DocumentProfile, ExtractionEngine, RouteDecision, RouteStrategy } from "../router/types.js";
import type {
  DictionaryCheck,
  DocumentSource,
  OcrEngine,
  OcrResult,
  Page,
  PageReason,
  PageSource,
  ParsedDocument,
  PdfDocumentLike,
  PdfLibrary,
  RasterAdapter,
} from "../types.js";
import type { ProgressStage } from "./protocol.js";
import { extractPageText, loadPdf } from "../pdf.js";
import { scoreTextLayer } from "../text/quality.js";
import { detectScript } from "../router/languages.js";
import { imageFormat, needsPngConversion } from "../image/convert.js";
import { abortError, isAbortError } from "../abort.js";

// ─── public contracts ────────────────────────────────────────────────────────

/** Multi-page / annotated extractor output (office readers, csv with encoding). */
export interface ExtractedPages {
  pages: string[];
  encoding?: string;
  format?: string;
  hasImages?: boolean;
  warnings?: string[];
}

/** A document-level text extractor (mammoth / xlsx / text / office). */
export type TextExtractor = (
  bytes: Uint8Array,
  ctx: { filename?: string; signal?: AbortSignal; kind?: string },
) => Promise<string | ExtractedPages>;

/** Per-page progress emitted while a strategy runs (mapped to a ProgressEvent by the shell). */
export interface RouteProgress {
  pageIndex: number;
  totalPages: number;
  stage: ProgressStage;
  engine?: ExtractionEngine;
}

export interface ExecuteRouteInput {
  bytes: Uint8Array;
  filename?: string;
  profile: DocumentProfile;
  route: RouteDecision;
  signal?: AbortSignal;
  /** Budget of pages that go through OCR/vision (native pages are free). `<= 0` / unset ⇒ uncapped. */
  maxPages?: number;
  /** Per-page rasterize / recognize timeout (ms). `<= 0` / unset ⇒ none. */
  perPageTimeoutMs?: number;
  /** Stop reading further pages once this many characters are collected. */
  maxChars?: number;
  /** Result shape (processing is always per page). Default "per-page". */
  pageOutput?: "per-page" | "single";
  /** ISO 639-1 language hint (e.g. "ar") — the script assumed for scanned pages. */
  languageHint?: string;
  /** Caller request id, forwarded to the vision step. */
  requestId?: string;
}

/** All injectable dependencies. Everything not provided is skipped (with a warning). */
export interface ExecuteRouteDeps {
  pdfjs?: PdfLibrary;
  raster?: RasterAdapter;
  /** OCR / vision engines keyed by tag. Missing or unavailable ⇒ leg skipped. */
  engines?: Partial<Record<ExtractionEngine, OcrEngine>>;
  /** Document-level text extractors keyed by tag. Missing ⇒ strategy skipped. */
  extractors?: Partial<Record<ExtractionEngine, TextExtractor>>;
  /** Progress callback (one per page/stage). */
  onProgress?: (e: RouteProgress) => void;
  /** Called once per finished page, in order. */
  onPage?: (page: Page) => void;
  /** Min non-whitespace chars for an output to count as usable. Default 3. */
  usableFloor?: number;
  /** Runner-hosted RapidOCR (browser → runner fallback for "edge" pages). */
  runnerOcr?: OcrEngine;
  /** Optional dictionary check on native pages. */
  dictionary?: DictionaryCheck;
  /** Office → PDF conversion (runner LibreOffice). Null result ⇒ unavailable. */
  convertToPdf?: (bytes: Uint8Array, filename: string | undefined, signal?: AbortSignal) => Promise<Uint8Array | null>;
}

export interface ExecuteRouteResult {
  document: ParsedDocument;
  /** Engine tag that produced (most of) the text; `undefined` if nothing yielded usable text. */
  engine?: ExtractionEngine;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const TEXT_ENGINES: ReadonlySet<ExtractionEngine> = new Set(["pdfjs-text", "mammoth", "xlsx", "text", "office"]);
const PAGE_ENGINES: ReadonlySet<ExtractionEngine> = new Set(["rapidocr", "granite-docling", "vlm"]);
const DEFAULT_CHAIN: RouteStrategy[] = [
  { engine: "rapidocr", location: "browser", reason: "per-page OCR" },
  { engine: "granite-docling", location: "browser", reason: "structure-aware fallback" },
  { engine: "vlm", location: "edge", reason: "vision last resort" },
];
/** Share of detected boxes thrown away as low-confidence that marks an "unreadable script". */
const DROPPED_SCRIPT_RATIO = 0.3;
/** Office text this sparse per page, with pictures inside, is worth a convert-to-PDF + OCR pass. */
const SPARSE_OFFICE_CHARS = 100;

function engineToSource(engine: ExtractionEngine): PageSource {
  switch (engine) {
    case "rapidocr":
    case "granite-docling":
      return "ocr";
    case "vlm":
      return "vlm";
    case "moonshine":
    case "stt-gateway":
      return "stt";
    default:
      return "native";
  }
}

function engineToStage(engine: ExtractionEngine): ProgressStage {
  switch (engine) {
    case "rapidocr":
      return "rapidocr";
    case "granite-docling":
      return "granite";
    case "vlm":
      return "vlm";
    case "moonshine":
    case "stt-gateway":
      return "stt";
    default:
      return "finalizing";
  }
}

function inBrowser(): boolean {
  const g = globalThis as { window?: unknown; navigator?: unknown; document?: unknown; self?: unknown };
  return typeof g.navigator !== "undefined" && (typeof g.window !== "undefined" || typeof g.self !== "undefined") && typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "undefined";
}

export function nonWsLen(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

const LANG_SCRIPT: Record<string, string> = { ar: "arabic", fa: "arabic", ur: "arabic", ru: "cyrillic", uk: "cyrillic", zh: "cjk", ja: "cjk", ko: "cjk", hi: "devanagari" };
function scriptFromLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const code = lang.toLowerCase().split(/[-_]/)[0]!;
  return LANG_SCRIPT[code] ?? "latin";
}

/** Race a promise against a timeout; late rejections from the orphan are swallowed. */
export async function withTimeout<T>(p: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function makePage(index: number, text: string, source: PageSource, extra: Partial<Page> = {}): Page {
  const page: Page = { index, text, source, pageNumber: index + 1, method: source };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) (page as unknown as Record<string, unknown>)[k] = v;
  }
  return page;
}

function docSource(pages: Page[]): DocumentSource {
  const read = pages.filter((p) => p.text.length > 0);
  if (read.length === 0) return "none";
  const first = read[0]!.source;
  return read.every((p) => p.source === first) ? first : "mixed";
}

/** Assemble a {@link ParsedDocument}; `single` merges every page into one entry. */
function buildParsedDocument(
  profile: DocumentProfile,
  pages: Page[],
  warnings: string[],
  extra: { totalPages?: number; encoding?: string; format?: string; pageOutput?: "per-page" | "single" } = {},
): ParsedDocument {
  const text = pages.map((p) => p.text).filter((t) => t.length > 0).join("\n\n");
  const source = pages.length ? docSource(pages) : "none";
  const flags = [...new Set(pages.flatMap((p) => p.flags ?? []))];
  for (const f of flags) if (!warnings.includes(f)) warnings.push(f);
  const meta = {
    pagesProcessed: pages.length,
    totalPages: extra.totalPages || pages.length || profile.pages || 1,
    nativePages: pages.filter((p) => p.source === "native").length,
    ocrPages: pages.filter((p) => p.source === "ocr").length,
    vlmPages: pages.filter((p) => p.source === "vlm").length,
    sttPages: pages.filter((p) => p.source === "stt").length,
    truncated: warnings.some((w) => w.startsWith("truncated_")),
    chars: text.length,
    ...(extra.encoding ? { encoding: extra.encoding } : {}),
    ...(extra.format ? { format: extra.format } : {}),
  };
  let outPages = pages;
  if (extra.pageOutput === "single" && pages.length > 0) {
    const src: PageSource = source === "mixed" || source === "none" ? pages[0]!.source : source;
    outPages = [makePage(0, text, src, { flags, method: src })];
    if (source === "mixed") outPages[0]!.engine = "mixed";
  }
  return { text, source, pages: outPages, warnings, kind: profile.kind, meta };
}

// ─── the per-page cascade ────────────────────────────────────────────────────

interface PageJob {
  index: number;
  totalPages: number;
  script: string;
  reason: PageReason;
  documentName?: string;
}

interface CascadeHit {
  text: string;
  source: PageSource;
  engine: string;
  tag: ExtractionEngine;
  reason: PageReason;
  flags: string[];
  script?: string;
}

class Runner {
  readonly warnings: string[] = [];
  private warned = new Set<string>();
  constructor(
    readonly input: ExecuteRouteInput,
    readonly deps: ExecuteRouteDeps,
  ) {}

  get floor(): number {
    return this.deps.usableFloor ?? 3;
  }

  warnOnce(w: string): void {
    if (this.warned.has(w)) return;
    this.warned.add(w);
    this.warnings.push(w);
  }

  checkAbort(): void {
    if (this.input.signal?.aborted) throw abortError();
  }

  /** OCR/vision legs for page images, in route order (default chain for digital PDFs). */
  chain(): RouteStrategy[] {
    const legs = this.input.route.strategies.filter((s) => PAGE_ENGINES.has(s.engine));
    return legs.length ? legs : DEFAULT_CHAIN;
  }

  private async recognize(engine: OcrEngine, png: Uint8Array, job: PageJob, script: string): Promise<OcrResult> {
    return withTimeout(
      engine.recognize(png, {
        pageIndex: job.index,
        totalPages: job.totalPages,
        signal: this.input.signal,
        script,
        reason: job.reason,
        documentName: job.documentName,
        requestId: this.input.requestId,
        languageHint: this.input.languageHint,
      }),
      this.input.perPageTimeoutMs,
      engine.name,
    );
  }

  /** Run one page image down the cascade. Returns null when no leg yielded usable text. */
  async cascade(png: Uint8Array, job: PageJob): Promise<CascadeHit | null> {
    const n = job.index + 1;
    const flags: string[] = [];
    let reason = job.reason;
    let fallback: CascadeHit | null = null;
    const local = this.deps.engines?.rapidocr;
    const runner = this.deps.runnerOcr;

    for (const leg of this.chain()) {
      this.checkAbort();
      let engine: OcrEngine | undefined;
      let script = job.script;
      if (leg.engine === "rapidocr") {
        const localOk = !!local?.available;
        const localScripts = local?.scripts ?? ["latin"];
        const scriptOk = script === "latin" || script === "unknown" || localScripts.includes(script);
        // `location: "edge"` is meaningful only in the browser (elsewhere every leg is "edge").
        const edgeLeg = leg.location === "edge" && inBrowser();
        const useRunner = !!runner?.available && (!localOk || !scriptOk || edgeLeg);
        if (useRunner) engine = runner;
        else if (!localOk || scriptOk) engine = local;
        else if (localOk) {
          flags.push(`no_local_model:${script}:page_${n}`);
          if (script === "arabic") reason = "arabic_no_local_model";
          continue;
        }
        if (script === "unknown") script = "latin";
      } else {
        engine = this.deps.engines?.[leg.engine];
      }
      if (!engine) {
        this.warnOnce(`${leg.engine}: engine not wired, skipping`);
        continue;
      }
      if (!engine.available) {
        this.warnOnce(`${engine.name}: unavailable in this runtime, skipping`);
        continue;
      }

      this.deps.onProgress?.({ pageIndex: job.index, totalPages: job.totalPages, stage: engineToStage(leg.engine), engine: leg.engine });
      let out: OcrResult;
      try {
        out = await this.recognize(engine, png, { ...job, reason }, script);
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.warnings.push(`${engine.name}: page ${job.index} failed (${(err as Error).message})`);
        continue;
      }
      const text = (out.text ?? "").trim();
      if (nonWsLen(text) < this.floor) {
        this.warnings.push(`${engine.name}: ${nonWsLen(text)} non-ws chars on page ${job.index}, falling through`);
        if (leg.engine === "rapidocr" && out.confidence !== undefined && out.confidence > 0) reason = "ocr_low_confidence";
        continue;
      }
      const hit: CascadeHit = { text, source: engineToSource(leg.engine), engine: engine.name, tag: leg.engine, reason, flags: [...flags], script: out.script === "mixed" || out.script === "arabic" ? out.script : undefined };

      if (out.script === "mixed") hit.flags.push(`ocr_mixed_script:page_${n}`);
      // Dropped-box signal: a Latin model dropping / barely reading ≥30% of boxes ⇒ an unreadable script (often Arabic).
      const unreadable = Math.max(out.weakBoxes ?? 0, out.droppedBoxes ?? 0);
      if (leg.engine === "rapidocr" && (out.totalBoxes ?? 0) >= 2 && (out.script ?? "latin") === "latin" && unreadable / out.totalBoxes! >= DROPPED_SCRIPT_RATIO) {
        flags.push(`ocr_dropped_script:page_${n}`);
        reason = "ocr_dropped_script";
        hit.flags = [...flags];
        hit.reason = reason;
        const arabicEngine = local?.available && local.scripts?.includes("arabic") ? local : runner?.available && engine !== runner ? runner : undefined;
        if (arabicEngine) {
          try {
            const ar = await this.recognize(arabicEngine, png, { ...job, reason }, "arabic");
            const arabicChars = (ar.text ?? "").match(/[\u0621-\u064A]/g)?.length ?? 0;
            if (arabicChars >= 4) return { ...hit, text: ar.text.trim(), engine: arabicEngine.name, script: ar.script ?? "arabic" };
            // The Arabic model found no Arabic: a weak Latin scan, not a script problem.
            return { ...hit, flags: hit.flags.filter((f) => !f.startsWith("ocr_dropped_script")), reason: job.reason };
          } catch (err) {
            if (isAbortError(err)) throw err;
          }
        }
        fallback = hit; // keep the partial read; let vision try for the full page
        continue;
      }
      return hit;
    }
    if (fallback) fallback.flags = [...new Set([...fallback.flags, ...flags])];
    return fallback ?? (flags.length ? { text: "", source: "ocr", engine: "none", tag: "rapidocr", reason, flags } : null);
  }

  /** Native page text → accept, or send the page down the cascade. */
  async readPdfPage(doc: PdfDocumentLike, i: number, total: number, state: { budget: number; docScript?: string }): Promise<Page> {
    const n = i + 1;
    let native = "";
    try {
      native = await extractPageText(await doc.getPage(n));
    } catch {
      native = "";
    }
    const quality = scoreTextLayer(native);
    const nativeScript = native ? detectScript(native) : "unknown";
    if (nativeScript !== "unknown") state.docScript ??= nativeScript;
    const flags: string[] = [];
    let reason: PageReason | undefined;
    if (nonWsLen(native) < this.floor) reason = "scanned";
    else if (quality.suspect) reason = "text_layer_suspect";
    const dict = this.deps.dictionary?.check(native);
    if (dict?.flagged) {
      flags.push(`dictionary_suspect:page_${n}`);
      if (!reason && this.deps.dictionary?.escalate) reason = "dictionary_suspect";
    }
    if (!reason) {
      return makePage(i, native, "native", { engine: "pdfjs-text", script: nativeScript, quality: quality.score, flags });
    }

    const script = scriptFromLanguage(this.input.languageHint) ?? (nativeScript !== "unknown" ? nativeScript : state.docScript ?? this.input.profile.script);
    const keepNative = (extra: string[]): Page => {
      const suspectFlag = reason === "text_layer_suspect" ? [`text_layer_suspect:page_${n}`] : [];
      if (native) return makePage(i, native, "native", { engine: "pdfjs-text", reason, script: nativeScript, quality: quality.score, flags: [...flags, ...suspectFlag, ...extra] });
      return makePage(i, "", "ocr", { reason, script, flags: [...flags, ...extra, `page_unread:page_${n}`] });
    };

    if (state.budget === 0) {
      this.warnOnce(`truncated_pages:ocr_budget_${this.input.maxPages}`);
      return keepNative([`ocr_skipped_budget:page_${n}`]);
    }
    if (!this.deps.raster?.available) {
      this.warnOnce("raster_unavailable: render failed (no raster adapter) — pages needing OCR/vision are kept native or flagged");
      return keepNative([]);
    }
    state.budget--;

    let png: Uint8Array;
    try {
      this.deps.onProgress?.({ pageIndex: i, totalPages: total, stage: "rendering" });
      png = await withTimeout(this.deps.raster.rasterizePdfPage(doc, i), this.input.perPageTimeoutMs, "render");
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.warnings.push(`render: page ${i} failed (${(err as Error).message})`);
      return keepNative([]);
    }
    const hit = await this.cascade(png, { index: i, totalPages: total, script, reason, documentName: this.input.filename });
    if (!hit || !hit.text) return keepNative(hit?.flags ?? []);
    if (reason !== "scanned" && native) {
      // Re-read of a readable-but-suspect page: keep whichever version scores better.
      const q = scoreTextLayer(hit.text);
      if (q.score <= quality.score) return keepNative([...hit.flags, `reread_kept_native:page_${n}`]);
      return makePage(i, hit.text, hit.source, { engine: hit.engine, reason: hit.reason, script: hit.script ?? script, quality: q.score, flags: [...flags, ...hit.flags, `text_layer_replaced:page_${n}`] });
    }
    return makePage(i, hit.text, hit.source, { engine: hit.engine, reason: hit.reason, script: hit.script ?? script, flags: [...flags, ...hit.flags] });
  }

  async runPdf(bytes: Uint8Array): Promise<{ pages: Page[]; total: number } | null> {
    let doc: PdfDocumentLike;
    try {
      ({ doc } = await loadPdf(bytes, this.deps.pdfjs));
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.warnings.push(`pdfjs_unavailable: ${(err as Error).message}`);
      return null;
    }
    const total = doc.numPages;
    const state = { budget: this.input.maxPages && this.input.maxPages > 0 ? this.input.maxPages : -1, docScript: undefined as string | undefined };
    if (this.input.profile.script !== "unknown") state.docScript = this.input.profile.script;
    const pages: Page[] = [];
    let chars = 0;
    for (let i = 0; i < total; i++) {
      this.checkAbort();
      if (this.input.maxChars && chars >= this.input.maxChars) {
        this.warnOnce(`truncated_pages:stopped_at_page_${i}_of_${total}_char_limit`);
        break;
      }
      const page = await this.readPdfPage(doc, i, total, state);
      chars += page.text.length;
      pages.push(page);
      this.deps.onPage?.(page);
    }
    return { pages, total };
  }

  async runImage(bytes: Uint8Array): Promise<{ pages: Page[]; total: number; format?: string }> {
    const format = imageFormat(bytes) ?? undefined;
    let frames: Uint8Array[] = [bytes];
    if (needsPngConversion(bytes)) {
      if (this.deps.raster?.imageToPng) {
        try {
          frames = await this.deps.raster.imageToPng(bytes, format!);
          if (frames.length === 0) frames = [bytes];
        } catch (err) {
          if (isAbortError(err)) throw err;
          this.warnings.push(`image_conversion_failed:${format} (${(err as Error).message})`);
        }
      } else {
        this.warnOnce(`image_not_converted:${format}`);
      }
    }
    const total = frames.length;
    const script = scriptFromLanguage(this.input.languageHint) ?? this.input.profile.script;
    const pages: Page[] = [];
    let budget = this.input.maxPages && this.input.maxPages > 0 ? this.input.maxPages : -1;
    for (let i = 0; i < total; i++) {
      this.checkAbort();
      if (budget === 0) {
        this.warnOnce(`truncated_pages:ocr_budget_${this.input.maxPages}`);
        break;
      }
      budget--;
      const hit = await this.cascade(frames[i]!, { index: i, totalPages: total, script, reason: "image", documentName: this.input.filename });
      const page = hit?.text
        ? makePage(i, hit.text, hit.source, { engine: hit.engine, reason: "image", script: hit.script ?? script, flags: hit.flags })
        : makePage(i, "", "ocr", { reason: "image", script, flags: hit?.flags });
      pages.push(page);
      this.deps.onPage?.(page);
    }
    return { pages, total, format };
  }
}

function mainEngine(pages: Page[]): ExtractionEngine | undefined {
  const read = pages.filter((p) => p.text);
  if (!read.length) return undefined;
  const counts = new Map<PageSource, number>();
  for (const p of read) counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (top === "native") return "pdfjs-text";
  if (top === "vlm") return "vlm";
  const ocr = read.find((p) => p.source === "ocr");
  return ocr?.engine?.includes("granite") ? "granite-docling" : "rapidocr";
}

// ─── executeRoute ────────────────────────────────────────────────────────────

/**
 * Execute a routed plan. PDFs and images run page by page (see file header). Other
 * kinds walk `route.strategies` in order, keeping the first that yields usable text.
 * Never throws for a strategy failure (those become warnings); only propagates an
 * `AbortError` when the caller's signal fires.
 */
export async function executeRoute(input: ExecuteRouteInput, deps: ExecuteRouteDeps = {}): Promise<ExecuteRouteResult> {
  const run = new Runner(input, deps);
  run.checkAbort();
  const shape = { pageOutput: input.pageOutput };
  const kind = input.profile.kind;

  if (kind === "pdf") {
    const out = await run.runPdf(input.bytes);
    const pages = out?.pages ?? [];
    const doc = buildParsedDocument(input.profile, pages, run.warnings, { ...shape, totalPages: out?.total });
    return { document: doc, engine: mainEngine(pages) };
  }
  if (kind === "image") {
    const out = await run.runImage(input.bytes);
    const doc = buildParsedDocument(input.profile, out.pages, run.warnings, { ...shape, totalPages: out.total, format: out.format });
    return { document: doc, engine: mainEngine(out.pages) };
  }

  const usableFloor = run.floor;
  for (const strategy of input.route.strategies) {
    run.checkAbort();

    if (TEXT_ENGINES.has(strategy.engine)) {
      const extractor = deps.extractors?.[strategy.engine];
      if (!extractor) {
        run.warnings.push(`${strategy.engine}: no extractor wired, skipping`);
        continue;
      }
      let out: string | ExtractedPages;
      try {
        out = await extractor(input.bytes, { filename: input.filename, signal: input.signal, kind });
      } catch (err) {
        if (isAbortError(err)) throw err;
        run.warnings.push(`${strategy.engine} extractor failed: ${(err as Error).message}`);
        if (strategy.engine === "office") {
          const converted = await convertAndRead(run, input, deps, "unreadable");
          if (converted) return converted;
        }
        continue;
      }
      const ex: ExtractedPages = typeof out === "string" ? { pages: [out] } : out;
      for (const w of ex.warnings ?? []) run.warnings.push(w);
      const texts = ex.pages.map((t) => t.trim());
      const chars = texts.reduce((a, t) => a + nonWsLen(t), 0);
      const suspect = texts.some((t) => scoreTextLayer(t).suspect);
      const sparse = !!ex.hasImages && chars / Math.max(1, texts.length) < SPARSE_OFFICE_CHARS;
      if (strategy.engine === "office" && (chars < usableFloor || suspect || sparse)) {
        const why = chars < usableFloor ? "empty" : suspect ? "suspect" : "images";
        const converted = await convertAndRead(run, input, deps, why);
        if (converted) return converted;
      }
      if (chars >= usableFloor) {
        const source = engineToSource(strategy.engine);
        const pages = texts.map((t, i) => makePage(i, t, source, { engine: strategy.engine, quality: scoreTextLayer(t).score }));
        for (const p of pages) deps.onPage?.(p);
        deps.onProgress?.({ pageIndex: 0, totalPages: input.profile.pages || 1, stage: "finalizing", engine: strategy.engine });
        return {
          document: buildParsedDocument(input.profile, pages, run.warnings, { ...shape, encoding: ex.encoding, format: ex.format }),
          engine: strategy.engine,
        };
      }
      run.warnings.push(`${strategy.engine}: only ${chars} non-ws chars, falling through`);
      continue;
    }

    // Page-image engine on a single-page input (audio clip, unknown binary → vlm).
    const engine = deps.engines?.[strategy.engine];
    if (!engine) {
      run.warnings.push(`${strategy.engine}: engine not wired, skipping`);
      continue;
    }
    if (!engine.available) {
      run.warnings.push(`${engine.name}: unavailable in this runtime, skipping`);
      continue;
    }
    const source = engineToSource(strategy.engine);
    deps.onProgress?.({ pageIndex: 0, totalPages: 1, stage: engineToStage(strategy.engine), engine: strategy.engine });
    let text = "";
    try {
      const out = await withTimeout(
        engine.recognize(input.bytes, { pageIndex: 0, totalPages: 1, signal: input.signal, requestId: input.requestId, documentName: input.filename }),
        input.perPageTimeoutMs,
        engine.name,
      );
      text = (out.text ?? "").trim();
    } catch (err) {
      if (isAbortError(err)) throw err;
      run.warnings.push(`${engine.name}: page 0 failed (${(err as Error).message})`);
    }
    if (nonWsLen(text) >= usableFloor) {
      const page = makePage(0, text, source, { engine: engine.name });
      deps.onPage?.(page);
      return { document: buildParsedDocument(input.profile, [page], run.warnings, shape), engine: strategy.engine };
    }
    run.warnings.push(`${engine.name}: ${nonWsLen(text)} non-ws chars across 1 page(s), falling through`);
  }

  return { document: buildParsedDocument(input.profile, [], run.warnings, shape), engine: undefined };
}

/** Office → PDF (runner LibreOffice) → the per-page PDF cascade. Null when unavailable. */
async function convertAndRead(run: Runner, input: ExecuteRouteInput, deps: ExecuteRouteDeps, why: string): Promise<ExecuteRouteResult | null> {
  if (!deps.convertToPdf) {
    run.warnOnce(`needs_runner_conversion:${input.profile.kind}:${why}`);
    return null;
  }
  let pdf: Uint8Array | null = null;
  try {
    pdf = await deps.convertToPdf(input.bytes, input.filename, input.signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    run.warnings.push(`libreoffice_conversion_failed: ${(err as Error).message}`);
    return null;
  }
  if (!pdf) {
    run.warnOnce(`libreoffice_unavailable:${input.profile.kind}:${why}`);
    return null;
  }
  run.warnings.push(`converted_via_libreoffice:${input.profile.kind}:${why}`);
  const out = await run.runPdf(pdf);
  if (!out || out.pages.every((p) => !p.text)) return null;
  const doc = buildParsedDocument(input.profile, out.pages, run.warnings, { pageOutput: input.pageOutput, totalPages: out.total, format: input.profile.kind });
  return { document: doc, engine: mainEngine(out.pages) };
}
