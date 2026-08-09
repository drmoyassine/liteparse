/**
 * Routing — the "route once" step that turns (profile, capabilities) into an
 * ordered execution plan ({@link RouteDecision}).
 *
 * Pure rules, no I/O, fully unit-testable (like classify/languages). It encodes
 * the ARCHITECTURE.md → Routing Matrix as code. The worker/executor then walks
 * `strategies` in order, keeping the first that yields usable text — that walk is
 * **char-count-gated**: a strategy is tried only if the prior one produced fewer
 * than `usableFloor` non-whitespace chars, so a strategy in the list costs nothing
 * unless the prior tier under-yields.
 *
 * The image matrix rows (plain text / table+form / handwriting+chart) differ only
 * in *how far* the targeted fallback chain descends — and that depth is decided at
 * execution time by how much text each tier yields (the profile carries no
 * content-type signal). So all OCR routes emit the full chain
 * `rapidocr → granite-docling → vlm`; executeRoute stops at the first tier that
 * yields usable text, so a simple screenshot stops at RapidOCR and never loads the
 * ~260MB Docling model. (Confidence-gated escalation — descending sooner on a
 * low-confidence-but-nonempty result — is a P5 refinement; 0.3.0 descends only on
 * the char-count floor, which never returns wrong text, only less-structured text.)
 *
 * See ARCHITECTURE.md → Routing Matrix, ROADMAP.md → Phase 2 (A7).
 */
import type {
  DocumentProfile,
  ExecutionLocation,
  RouteDecision,
  RouteOptions,
  RouteStrategy,
  RuntimeCapabilities,
  Script,
} from "./types.js";

/** Default in-browser scanned-PDF page cap when WebGPU is available. */
const DEFAULT_BROWSER_OCR_PAGES_WEBGPU = 10;
/** Default in-browser scanned-PDF page cap on WASM only (no WebGPU). */
const DEFAULT_BROWSER_OCR_PAGES_WASM = 3;
/**
 * Digital-PDF browser page cap. pdfjs text extraction needs no GPU, but very
 * large docs are offloaded to the edge (matches the matrix's ≤10 / >10 split).
 */
const DEFAULT_DIGITAL_PDF_BROWSER_PAGES = 10;

/**
 * Is `script`'s recognition model available in-browser right now?
 *
 * Latin is the always-loaded baseline, and `unknown` (e.g. a raw image before any
 * OCR) is treated as Latin-covered: the primary recognition pass runs Latin and,
 * if confidence is low, the targeted fallback (Docling/VLM) takes over. Any other
 * script must be present in `caps.availableScripts` (the "Latin + 1 dynamic" cap).
 */
function scriptAvailableForBrowser(
  caps: RuntimeCapabilities,
  script: Script,
): boolean {
  if (script === "latin" || script === "unknown") return true;
  return caps.availableScripts.includes(script);
}

/**
 * Where the RapidOCR leg runs. Browser iff we're in a browser runtime, the page
 * count is within the (WebGPU/WASM) cap, and the detected script's recognition
 * model is already available locally — otherwise the edge (which has every
 * language loaded at cold start).
 */
function rapidocrLocation(
  profile: DocumentProfile,
  caps: RuntimeCapabilities,
  webgpuCap: number,
  wasmCap: number,
): ExecutionLocation {
  if (caps.runtime !== "browser") return "edge";
  const cap = caps.hasWebGPU ? webgpuCap : wasmCap;
  if (profile.pages > cap) return "edge";
  if (!scriptAvailableForBrowser(caps, profile.script)) return "edge";
  return "browser";
}

/**
 * Where the Granite-Docling leg runs. Docling is a ~258M VLM that is impractical
 * on WASM (15–30s/page), so in the browser it is strictly gated on WebGPU AND the
 * page cap; otherwise the edge. Script never affects Docling placement (it is a
 * vision model, not a per-script recogniser).
 */
function doclingLocation(
  profile: DocumentProfile,
  caps: RuntimeCapabilities,
  webgpuCap: number,
): ExecutionLocation {
  if (caps.runtime !== "browser") return "edge";
  if (!caps.hasWebGPU) return "edge";
  if (profile.pages > webgpuCap) return "edge";
  return "browser";
}

/** The recognition model script to put on a RapidOCR strategy (unknown → latin). */
function recScript(script: Script): Script {
  return script === "unknown" ? "latin" : script;
}

/**
 * Build the ordered OCR chain `rapidocr → granite-docling → vlm` for an image or
 * scanned PDF, with each leg's location decided independently. The VLM last resort
 * is appended only when a hosted VLM gateway is configured.
 */
function ocrChain(
  profile: DocumentProfile,
  caps: RuntimeCapabilities,
  webgpuCap: number,
  wasmCap: number,
  vlmEnabled: boolean,
): RouteStrategy[] {
  const chain: RouteStrategy[] = [
    {
      engine: "rapidocr",
      location: rapidocrLocation(profile, caps, webgpuCap, wasmCap),
      script: recScript(profile.script),
      reason: "primary OCR",
    },
    {
      engine: "granite-docling",
      location: doclingLocation(profile, caps, webgpuCap),
      reason: "structure-aware fallback (RapidOCR under-yielded)",
    },
  ];
  if (vlmEnabled) {
    chain.push({
      engine: "vlm",
      location: "edge",
      reason: "hosted VLM last resort",
    });
  }
  return chain;
}

/** One-line human summary of the decision, e.g. "scanned pdf, 15p, cjk → edge rapidocr → edge granite → vlm". */
function summarize(profile: DocumentProfile, strategies: RouteStrategy[]): string {
  const head = `${profile.kind}${profile.pages > 1 ? `, ${profile.pages}p` : ""}${
    profile.script !== "unknown" ? `, ${profile.script}` : ""
  }`;
  const tail = strategies
    .map((s) => `${s.location === "edge" ? "edge " : ""}${s.engine}`)
    .join(" → ");
  return `${head} → ${tail}`;
}

/**
 * Route a pre-classified document to an ordered execution plan.
 *
 * @param profile       Output of {@link classifyDocument} (kind/pages/scanned/script).
 * @param capabilities  Output of {@link detectCapabilities} (runtime/WebGPU/scripts).
 * @param opts          Tuning knobs (page caps) + whether a VLM gateway is configured.
 * @returns A {@link RouteDecision}; never throws.
 */
export function routeDocument(
  profile: DocumentProfile,
  capabilities: RuntimeCapabilities,
  opts?: RouteOptions,
): RouteDecision {
  const webgpuCap = opts?.browserOcrPagesWebGPU ?? DEFAULT_BROWSER_OCR_PAGES_WEBGPU;
  const wasmCap = opts?.browserOcrPagesWasm ?? DEFAULT_BROWSER_OCR_PAGES_WASM;
  const digitalCap = opts?.browserDigitalPdfPages ?? DEFAULT_DIGITAL_PDF_BROWSER_PAGES;
  const vlmEnabled = opts?.vlmEnabled ?? false;
  const inBrowser = capabilities.runtime === "browser";
  // `edgeUrl` is consumed by the executor (where to call the edge), not by routing.
  void opts?.edgeUrl;

  let strategies: RouteStrategy[];

  switch (profile.kind) {
    // ── Office / text: deterministic, cheap, runs wherever the caller is. ──
    case "docx":
      strategies = [
        { engine: "mammoth", location: inBrowser ? "browser" : "edge", reason: "office document" },
      ];
      break;
    case "xlsx":
    case "csv":
      strategies = [
        { engine: "xlsx", location: inBrowser ? "browser" : "edge", reason: "spreadsheet/csv via sheetjs" },
      ];
      break;
    case "text":
      strategies = [
        { engine: "text", location: inBrowser ? "browser" : "edge", reason: "plain text" },
      ];
      break;

    // ── Image / screenshot: full OCR chain; executeRoute stops at the first tier that yields usable text. ──
    case "image":
      strategies = ocrChain(profile, capabilities, webgpuCap, wasmCap, vlmEnabled);
      break;

    // ── PDF: branch on scanned state. ──
    case "pdf":
      if (profile.scanned === false) {
        // Digital PDF: native text layer only (cheap, deterministic).
        const loc: ExecutionLocation =
          inBrowser && profile.pages <= digitalCap ? "browser" : "edge";
        strategies = [
          { engine: "pdfjs-text", location: loc, reason: "digital PDF text layer" },
        ];
      } else if (profile.scanned === null && profile.pages > 0) {
        // Ambiguous scan state: try cheap native text first, then the OCR chain.
        const nativeLoc: ExecutionLocation =
          inBrowser && profile.pages <= digitalCap ? "browser" : "edge";
        strategies = [
          { engine: "pdfjs-text", location: nativeLoc, reason: "ambiguous scan; try native text first" },
          ...ocrChain(profile, capabilities, webgpuCap, wasmCap, vlmEnabled),
        ];
      } else {
        // Scanned PDF, OR scanned===null with pages===0 (pdfjs was unavailable
        // locally so we couldn't even open it). pages===0 ⇒ we can't render any
        // page locally ⇒ force every leg to the edge by treating this as a
        // non-browser runtime for location purposes.
        const effCaps =
          profile.pages === 0
            ? { ...capabilities, runtime: "node" as const }
            : capabilities;
        strategies = ocrChain(profile, effCaps, webgpuCap, wasmCap, vlmEnabled);
      }
      break;

    // ── Unknown binary: best-effort. ──
    case "other":
    default:
      strategies = vlmEnabled
        ? [{ engine: "vlm" as const, location: "edge" as const, reason: "unknown kind; VLM best-effort" }]
        : [{ engine: "text" as const, location: inBrowser ? ("browser" as const) : ("edge" as const), reason: "unknown kind; best-effort text read" }];
      break;
  }

  return { strategies, reason: summarize(profile, strategies) };
}
