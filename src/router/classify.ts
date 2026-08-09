/**
 * Document classification — the single cheap pass that produces a
 * {@link DocumentProfile} at attach time (overlapping user typing, so it is
 * essentially free by send).
 *
 * Classification is content-sniff + structural probe only: no OCR, no model
 * loads, no rendering beyond pdfjs' text layer. Target budget is well under
 * ~300ms on typical fixtures (see ARCHITECTURE.md → Classification Signals).
 *
 * Contract guarantees:
 *  - **Never throws for content/library problems.** If pdfjs is unavailable or
 *    the document is corrupt, the profile degrades to `{ pages: 0, scanned:
 *    null, script: "unknown" }` with a `pdfjs_unavailable` note.
 *  - The only thrown exception is an `AbortError` when the caller signals abort.
 */
import type { DocKind, PdfLibrary } from "../types.js";
import type { DocumentProfile, Script } from "./types.js";
import { sniff } from "../sniff.js";
import { extractPageText, loadPdf, nonWhitespaceLength } from "../pdf.js";
import { detectScript } from "./languages.js";

/** Options for {@link classifyDocument}. */
export interface ClassifyOptions {
  /** Injected pdfjs instance (avoids CDN/worker setup and lets tests fake the doc). */
  pdfjs?: PdfLibrary;
  /** Max pages to probe for the scanned/digital decision. Default 3. */
  maxProbePages?: number;
  /** MIME type if the caller already knows it (e.g. from a File.type / upload
   *  header); forwarded to {@link sniff} to disambiguate magic-byte ties. */
  mime?: string;
  /** Abort classification. Resolving an already-aborted signal throws AbortError. */
  signal?: AbortSignal;
}

// Decision thresholds (ARCHITECTURE.md → Signal 3: Scanned vs Digital).
const DIGITAL_THRESHOLD = 100; // first-page nonWs >= 100 → has a real text layer
const SCANNED_THRESHOLD = 10; // first-page nonWs < 10 → text is in images
const DEFAULT_PROBE_PAGES = 3;
const TEXT_SAMPLE_BYTES = 8192;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("classifyDocument aborted", "AbortError");
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Decode up to 8KB of the input as utf-8, for script detection on text/csv. */
function decodeUtf8Sample(bytes: Uint8Array): string {
  const end = Math.min(bytes.length, TEXT_SAMPLE_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
}

/**
 * Decide scanned vs digital from the per-page non-whitespace counts.
 *
 * - Page 1 is authoritative when decisive (>= DIGITAL_THRESHOLD → digital;
 *   < SCANNED_THRESHOLD → scanned).
 * - An ambiguous page 1 falls back to a majority vote across all probed pages
 *   (each page votes digital/scanned only if it is itself decisive). A tie or
 *   no decisive votes yields `null` (ambiguous).
 */
function decideScanned(pageNonWs: readonly number[], first: number): boolean | null {
  if (first >= DIGITAL_THRESHOLD) return false;
  if (first < SCANNED_THRESHOLD) return true;
  let digital = 0;
  let scannedVotes = 0;
  for (const n of pageNonWs) {
    if (n >= DIGITAL_THRESHOLD) digital++;
    else if (n < SCANNED_THRESHOLD) scannedVotes++;
  }
  if (digital > scannedVotes) return false;
  if (scannedVotes > digital) return true;
  return null;
}

function buildProfile(
  kind: DocKind,
  pages: number,
  scanned: boolean | null,
  script: Script,
  bytes: Uint8Array,
  notes: string[],
): DocumentProfile {
  const profile: DocumentProfile = {
    kind,
    pages,
    scanned,
    script,
    bytes: bytes.byteLength,
  };
  if (notes.length > 0) profile.notes = notes;
  return profile;
}

/**
 * Classify a document once, cheaply.
 *
 * @param bytes   Raw document bytes (magic bytes drive the kind).
 * @param filename Original filename (used when magic bytes are ambiguous).
 * @param opts    Optional pdfjs instance, probe depth, and abort signal.
 * @returns A {@link DocumentProfile}. Never throws for content problems.
 */
export async function classifyDocument(
  bytes: Uint8Array,
  filename: string | undefined,
  opts?: ClassifyOptions,
): Promise<DocumentProfile> {
  const maxProbePages = Math.max(1, opts?.maxProbePages ?? DEFAULT_PROBE_PAGES);
  const signal = opts?.signal;

  const sniffed = sniff({ bytes, filename, mime: opts?.mime });
  const notes: string[] = [...sniffed.warnings];

  // Non-PDF inputs: a single notional page; scanned is not applicable.
  if (sniffed.kind !== "pdf") {
    const script: Script =
      sniffed.kind === "text" || sniffed.kind === "csv"
        ? detectScript(decodeUtf8Sample(bytes))
        : "unknown";
    return buildProfile(sniffed.kind, 1, null, script, bytes, notes);
  }

  // PDF path — probe the text layer to decide scanned vs digital.
  assertNotAborted(signal);

  let pages = 0;
  let scanned: boolean | null = null;
  let script: Script = "unknown";
  let probeNote: string | null = null;

  try {
    const { doc } = await loadPdf(bytes, opts?.pdfjs);
    pages = doc.numPages;

    const probeCount = Math.min(maxProbePages, pages);
    const pageTexts: string[] = [];
    const pageNonWs: number[] = [];
    for (let i = 1; i <= probeCount; i++) {
      assertNotAborted(signal);
      const page = await doc.getPage(i);
      const text = await extractPageText(page);
      pageTexts.push(text);
      pageNonWs.push(nonWhitespaceLength(text));
    }

    const first = pageNonWs[0];
    if (first !== undefined) {
      probeNote = `textLayer probe: ${first} chars on page 1`;
      scanned = decideScanned(pageNonWs, first);
    }

    // Script detection runs on the joined probed text (whitespace-insensitive).
    script = detectScript(pageTexts.join(" "));
  } catch (err) {
    // Abort propagates; everything else (missing pdfjs, corrupt PDF, probe
    // failure) degrades gracefully — classifyDocument must not throw here.
    if (isAbortError(err)) throw err;
    notes.push("pdfjs_unavailable");
    pages = 0;
    scanned = null;
    script = "unknown";
    probeNote = null;
  }

  if (probeNote) notes.push(probeNote);
  return buildProfile(sniffed.kind, pages, scanned, script, bytes, notes);
}
