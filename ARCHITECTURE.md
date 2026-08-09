# liteparse Architecture — Intelligent Document Router

> **Status**: Design document for liteparse 0.3.0+
> **Date**: 2026-08-09
> **Decision**: Replace brute-force fallback cascade with profile-based intelligent routing

---

## Problem Statement

The current 0.1.0–0.2.0 architecture uses a **linear cascade with brute-force
fallback**: try local extraction (8s timeout) → try server → try edge function.
This is wasteful:

- A 10-page scanned PDF wastes 8 seconds attempting local extraction that was
  always going to fail (browser can't OCR without WASM models loaded).
- Every document hits the same fixed cascade regardless of its characteristics.
- No document intelligence before extraction begins.

## Solution: Classify → Route → Execute

```
Document bytes
  → classify (type, pages, scanned, script, language-hint)
  → route (profile + runtime capabilities → ordered strategy list)
  → execute (run the chosen strategy, with targeted fallback only)
```

Classification happens **at attach time** (overlaps with user typing their
message), so by send time the route is already decided — zero classification
latency at send.

---

## Classification Signals

Four signals, each detectable cheaply in the browser:

### Signal 1: File Type (~0ms)
Already handled by `sniff.ts`. MIME type + filename extension → `DocKind`.

### Signal 2: Page Count (~50-200ms for PDFs)
pdfjs `getDocument(bytes).promise.numPages` — reads PDF structure metadata
without rendering any pages.

### Signal 3: Scanned vs Digital (~100-300ms for PDFs)
Probe page 1's text layer with pdfjs:
```
const textContent = await page.getTextContent()
const charCount = items.reduce((sum, item) => sum + item.str.length, 0)
```
- `charCount > 100` → **digital** (has a real text layer)
- `charCount < 10` → **scanned** (text is in images)
- Ambiguous → probe 2-3 more pages; if inconsistent → treat as scanned

### Signal 4: Script / Language Hint (~50ms, optional)
From the rendered first page, detect script family:
- Latin (en, es, it, fr, de, …)
- Arabic (ar)
- CJK (zh, ja, ko)
- Cyrillic (ru)

Primary language hint comes from **user context** (profile country/locale) —
free and instant. Script detection confirms it.

---

## Routing Matrix

| Type | Pages | Scanned? | Script in Browser? | Route |
|------|-------|----------|---------------------|-------|
| Image / screenshot (plain text/UI) | 1 | — | yes | **Browser RapidOCR** |
| Image / screenshot (table/form/multi-col) | 1 | — | yes | Browser RapidOCR → **Docling** (structure) |
| Image / screenshot (handwriting/chart) | 1 | — | yes | Browser RapidOCR → Docling → **VLM (edge)** |
| Image / screenshot | 1 | — | no | **Edge RapidOCR** → Edge Docling → VLM |
| DOCX / XLSX / CSV / TXT / MD | — | — | — | **Browser** (mammoth/xlsx/readAsText) |
| Digital PDF | ≤10 | no | — | **Browser pdfjs text** |
| Digital PDF | >10 | no | — | **Edge pdfjs text** |
| Scanned PDF | ≤3 (WASM) / ≤10 (WebGPU) | yes | yes | **Browser RapidOCR** → Docling (if low conf) |
| Scanned PDF | ≤3 (WASM) / ≤10 (WebGPU) | yes | no | **Edge RapidOCR** → Edge Docling |
| Scanned PDF | >threshold | yes | — | **Edge RapidOCR** → Edge Docling → VLM |

### Fallback within each route (targeted, not brute-force)
```
RapidOCR (browser or edge)
  ↓ empty or low confidence?
Granite-Docling-258M (local VLM, structure-aware)
  ↓ still failing (<5%)?
Hosted VLM (Gemini/GLM) — true last resort
```

ocr.space: **removed entirely**. RapidOCR replaces it in all cases.

> **0.3.0 status (cascade gating).** The descent above is **char-count-gated only**:
> a tier runs iff the prior one yielded fewer than `usableFloor` (default 3) non-
> whitespace characters — it never returns *wrong* text, only less-structured text.
> The "low confidence?" branch is a **P5 refinement**: descending sooner on a
> low-confidence-but-nonempty RapidOCR result (to get Docling's structure) requires
> real per-engine confidence data and a tuned threshold, which lands with the edge
> dispatch in P5. Granite-Docling placement is **script-independent** (it is a vision
> model, not a per-script recogniser), so `location` depends only on WebGPU + page cap.

---

## Language Strategy

### Model Organisation (PaddleOCR / RapidOCR)
- **Detection model**: ONE model, language-agnostic (~8MB). Finds text regions
  regardless of language.
- **Recognition models**: one per script/language group (~8MB each):
  - PP-OCRv4 `latin`: covers en, es, it, fr, de, +30 others (one model)
  - PP-OCRv4 `arabic`: Arabic script (separate model, RTL handling)
  - PP-OCRv4 `cyrillic`: Russian, Ukrainian, etc.
  - PP-OCRv4 `japan`, `korean`, etc.: CJK scripts

### Browser Language Cap: Latin + 1 Dynamic

**Default browser payload** (loaded on first use, cached in IndexedDB):
```
Detection model (~8MB)
Latin recognition model (~8MB)  ← covers English + Spanish + Italian + 30 others
Total: ~16MB
```

**Dynamic second language** (lazy, on first non-Latin script detection):
```
1. Script detection finds Arabic (or CJK, Cyrillic, etc.)
2. Check the local tier (IndexedDB): model cached?
   - No → fetch from S3 origin (~8MB), cache permanently in IndexedDB
   - Yes → use cached model
3. Browser now has: Latin + Arabic (2 scripts max)
4. Third script detected → route to EDGE permanently (browser won't download more)
```

This means:
- Italian/Spanish students: browser handles everything (Latin script covers it)
- Arabic students: one extra download, then browser handles English + Arabic
- All other languages: edge handles them, browser never downloads

### Edge Language Config

```env
# All enabled languages on the edge/server
RAPIDOCR_LANGUAGES=en,ar,es,it,fr,de
```

The edge loads detection + all listed recognition models at cold start.

### Configuration Variables

```env
# Edge: all languages available
RAPIDOCR_LANGUAGES=en,ar,es,it,fr,de

# Browser: dynamically managed (Latin always + 1 lazy)
# No env var needed — the browser self-manages via IndexedDB

# Optional: pre-seed browser with user's language at app load
RAPIDOCR_BROWSER_PRESEED=ar   # download Arabic model on first app load
```

---

## Web Worker Architecture

### Why Web Worker (not Service Worker)

| | Web Worker | Service Worker |
|---|---|---|
| Purpose | CPU-heavy computation | Network proxy, offline cache |
| ONNX inference | ✅ Designed for this | ❌ Not for computation |
| GPU (WebGPU) | ✅ Supported | ❌ No |
| Lifecycle | Tied to page (fine for us) | Independent (overkill) |
| OffscreenCanvas | ✅ Yes | ❌ No |

**Decision**: Dedicated Web Worker. The worker owns the entire document
processing pipeline.

### Worker Pipeline

```
Main Thread                     Web Worker
─────────────                   ──────────────────────────────
attach file ──postMessage──▶   receive bytes + profile
                                │
                                ├─ pdfjs render → OffscreenCanvas
                                ├─ preprocess (grayscale, deskew)
                                ├─ RapidOCR inference (onnxruntime-web)
                                │   ↓ low confidence?
                                ├─ Granite-Docling inference (WebGPU)
                                │   ↓ still failing?
                                ├─ (signal failure for edge fallback)
                                │
show progress ◀──postMessage──  return text + structure
```

The worker reports **per-page progress** via postMessage, so the UI shows:
```
Processing page 2/5… (RapidOCR)
```

### WebGPU Detection

```typescript
// Worker initialization
const adapter = await navigator.gpu?.requestAdapter()
const hasWebGPU = !!adapter

// Routing impact:
// hasWebGPU → can run Granite-Docling locally, handle 10+ pages
// !hasWebGPU → RapidOCR WASM only, cap at 3 pages, Granite → edge
```

onnxruntime-web with WebGPU execution provider handles all GPU tensor
operations. No separate graphics library needed. OffscreenCanvas 2D context
handles image preprocessing. The stack is:

```
pdfjs → OffscreenCanvas → onnxruntime-web (WebGPU EP or WASM SIMD) → text
```

---

## Granite-Docling-258M Integration

### What It Adds

Granite-Docling-258M is an ultra-compact VLM (258M params, Apache 2.0) that
understands **document structure** — tables, reading order, formulas, headings,
image classification. It fills the gap between raw OCR (RapidOCR) and full
hosted VLM (Gemini/GLM).

### Cascade Position

```
Tier 1: pdfjs text extraction (digital PDFs — instant)
Tier 2: RapidOCR (scanned docs — ~1s/page, ~16MB model)
Tier 3: Granite-Docling (complex docs — ~2-3s/page, ~260MB model)
Tier 4: Hosted VLM (Gemini/GLM — exception handler, <5%)
```

### Placement

**Edge**: Always loaded at cold start. Handles any document RapidOCR struggles
with. ~260MB in memory is fine for serverless.

**Browser**: Eager download on first launch, **gated on WebGPU**. Without GPU,
258M params is impractical on WASM (15–30s/page), so a device without WebGPU
does not download docling at all — those docs route to edge docling.

```
On first launch (inside Web Worker):
  1. const adapter = await navigator.gpu?.requestAdapter()
  2. adapter present?
     YES → download Granite-Docling ONNX in background, cache in IndexedDB
     NO  → skip; complex docs route to edge docling instead

At extraction time:
Complex scanned document, low RapidOCR confidence
  → WebGPU available AND Granite cached in IndexedDB?
    YES → Browser Granite-Docling (local, private, ~2–3s)
    NO  → Edge Granite-Docling (server-side, ~2–3s)
```

#### Download is gated on WebGPU, not user opt-in

The previous design required the user to opt into a ~260MB download. The
refined design is **eager-but-gated**: if the device can run docling fast
(WebGPU present), download it automatically on first launch so the best local
engine is always warm — no user friction. Devices that can't run it never pay
the cost. See **GPU Detection & First-Launch Download** below for the tiered
download order and storage/connection guards.

### Model Details

- Upstream: IBM `ibm-granite/granite-docling-258M` (HuggingFace). **Runtime origin: our S3 bucket** — models are mirrored to S3 and fetched from there at runtime, never bundled into a client and never pulled directly from HuggingFace in production. See [Model Storage & Fetch](#model-storage--fetch) below.
- Format: ONNX (3.1x faster than PyTorch, 57% less memory)
- Quantization: INT8 (~258MB) or INT4 (~130MB) for browser; FP16 (~516MB) for
  edge. Exact file sizes must be verified against the published ONNX export;
  figures here are estimated from the 258M param count × bytes/param.
- Execution: onnxruntime-web (browser, WebGPU), onnxruntime-node (edge)

### Docling library ≠ Granite-Docling-258M model (don't conflate)

Two distinct things share the name:

- **Docling (the library)** — IBM's Python document-conversion *pipeline toolkit*.
  It supports several swappable OCR backends (EasyOCR, RapidOCR, Tesseract), OCR
  is off by default, and RapidOCR is one optional backend — not bundled.
- **Granite-Docling-258M (the model)** — the 258M-param VLM (IDEFICS3 +
  `siglip2-base-patch16` encoder) we run in the browser/edge. It performs
  OCR-equivalent extraction **in its own forward pass**. It contains **no
  RapidOCR component.**

We run the **model**, not the library (our edge is Vercel Node, not Python).
Therefore RapidOCR and Granite-Docling are **two independent model files** —
RapidOCR is not a dependency of Granite-Docling at the model level. We keep
standalone RapidOCR as the fast/lightweight tier for all devices (it runs on
WASM where Granite-Docling is unusable), and layer Granite-Docling on top for
WebGPU devices only.

---

## GPU Detection & First-Launch Download

Models download **eagerly on first launch**, gated on what the device can
actually run. The Web Worker does all detection + fetching so the main thread
never blocks.

### Capability detection (worker init)

```typescript
// Inside Web Worker
const hasWebGPU = !!(await navigator.gpu?.requestAdapter())
const connection = navigator.connection  // optional, may be undefined
const metered = connection?.saveData ||
                ['slow-2g','2g','3g'].includes(connection?.effectiveType ?? '')
const persisted = navigator.storage?.persisted?.() ?? false
```

### Tiered download order

| # | What | Size | When | Gate |
|---|------|------|------|------|
| 1 | Detection model + Latin recognition | ~16MB | Immediately, blocks first OCR | always |
| 2 | User's pre-seeded non-Latin language (if set) | ~8MB | Background | `RAPIDOCR_BROWSER_PRESEED` |
| 3 | Granite-Docling (INT4 if available, else INT8) | ~130–258MB | Background, after #1 | **WebGPU AND not metered** |

Everything caches in the **local tier** — IndexedDB (browser) / local disk (edge) — and persists across sessions. The **origin** for every fetch is our **S3 bucket**, not HuggingFace (see Model Storage & Fetch below).

### Storage + connection guards (for the large Tier 3 download)

- **Request persistent storage** so the browser doesn't evict the ~130–258MB
  model under disk pressure: `await navigator.storage.persist()`. Without it,
  IndexedDB can be silently cleared.
- **Skip/defer on metered connections** — wait for WiFi via
  `navigator.connection`. A 258MB hit on cellular for a feature the user may
  not hit for days is not worth it. Re-check on `change` events.
- **Validate before use** — on every launch, check the cached model's hash/
  version matches the expected build; re-download only if stale.

### No-WebGPU devices

If the adapter is absent, docling never downloads. Documents that would have
escalated to browser docling instead route to **edge docling** (which has GPU
or fast CPU). RapidOCR still runs in the browser on those devices (WASM SIMD
is fine for OCR-scale models; only the 258M docling model needs the GPU).

### Model Storage & Fetch

Models are **never baked into a runtime**. Two tiers:

1. **Origin — S3 bucket** (ours). Every model artifact — the Granite-Docling ONNX
   shards and the per-script RapidOCR recognition models — is mirrored to S3
   (versioned, fronted by CloudFront/CDN). S3, not HuggingFace, is the production
   fetch origin: it removes HF rate limits, gives us version pinning +
   invalidation control, and keeps the fetch behind our own CDN/auth. HuggingFace
   is only the *upstream* we seed the bucket from.
2. **Local tier** — `IndexedDB` in the browser worker (wrapped by
   `worker/model-cache.ts`), ephemeral/disk on the edge. Checked first; on a miss
   the worker fetches from S3 and writes through to the local tier, so repeat
   loads are free.

The fetch is behind a **`ModelOrigin` adapter** (injectable, like `OcrEngine` /
`RasterAdapter` / `VlmGateway`): liteparse owns the contract —
`fetchModel(descriptor): Promise<Uint8Array>` plus an `etag`/`exists` check for
validate-before-use — and the local cache; the consumer injects the
S3/CloudFront implementation (it carries the credentials/SDK, liteparse stays
dependency-free). Wired in Phase 2 (A8 worker).

> **Out of scope for liteparse and the router (P2–P5):** the broader state +
> cache/queue platform — a serverless state DB (Turso / libSQL-class) for
> in-process & output data, and serverless cache + queue providers (Upstash,
> QStash, serverless Redis / KV, Dragonfly, …). All adapter-style and swappable,
> and **all in a separate project as future independent stages** — not liteparse,
> not this router build. liteparse only defines the `ModelOrigin` seam above.

---

## Image / Screenshot Routing Detail

**Docling is NOT in the primary path for images.** A plain screenshot extracts
the same text in ~300ms via RapidOCR vs ~2–3s via docling — same result, ~8–10×
slower. Having docling downloaded removes the *delay* of escalation, not the
*decision* to escalate.

```
Image/screenshot
  → RapidOCR (always, fast text extraction)
  → escalate to Docling ONLY when:
      (a) RapidOCR confidence is low / output empty or very short, OR
      (b) structure needed: table, form, multi-column layout
          (cheap heuristic: page-like aspect ratio, many short aligned lines,
           columns of numbers in the OCR output)
  → escalate to VLM (edge) ONLY when:
      handwriting, whiteboard, chart/diagram to interpret, scene text
      (RapidOCR + docling both fail on these)
```

So: **plain text screenshot → RapidOCR only. Table photo → RapidOCR then
docling. Handwritten note → straight to VLM.** Docling sees an image only when
its structure-recovery earns its ~2–3s cost.

---

## Full Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    BROWSER (Web Worker)                       │
│                                                               │
│  classify(bytes) → { type, pages, scanned, script }           │
│                                                               │
│  ROUTER:                                                      │
│    Images (plain)   → RapidOCR (latin + 1 dynamic lang)       │
│    Images (struct.) → RapidOCR → Docling (low-conf/table)     │
│    Images (hw/chart)→ RapidOCR → Docling → VLM (edge)         │
│    Office/TXT      → mammoth/xlsx/readAsText                  │
│    Digital PDF ≤10 → pdfjs text extraction                    │
│    Digital PDF >10 → EDGE                                     │
│    Scanned PDF ≤N  → RapidOCR → Docling (WebGPU) → EDGE       │
│    Scanned PDF >N  → EDGE                                     │
│                                                               │
│  MODELS (IndexedDB):                                          │
│    det (~8MB) + latin rec (~8MB) = always (tier 1)            │
│    + 1 non-latin rec (~8MB) = lazy on first detection         │
│    + Granite (~130–258MB) = eager on first launch, WebGPU-gated │
│                                                               │
│  GPU: WebGPU EP (fast) → fallback WASM SIMD (slower)          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    EDGE / SERVER                              │
│                                                               │
│  ALL languages (RAPIDOCR_LANGUAGES=en,ar,es,it,fr,de)         │
│  RapidOCR-node (sharp → ONNX)                                 │
│    ↓ low confidence                                           │
│  Granite-Docling-258M (ONNX, always loaded)                   │
│    ↓ still failing (<5%)                                      │
│  Hosted VLM (Gemini/GLM) — last resort                        │
└──────────────────────────────────────────────────────────────┘
```

---

## liteparse Module Structure (Proposed)

```
src/
├── index.ts                    # public API (unchanged surface)
├── types.ts                    # + DocumentProfile, Route, Strategy types
├── sniff.ts                    # file type classification (existing)
├── pipeline.ts                 # parseDocument (existing)
├── cascade.ts                  # parseWithFallbacks (existing, fed by router)
│
├── router/                     # NEW — intelligent routing
│   ├── classify.ts             # DocumentProfile = classify(bytes, filename)
│   ├── route.ts                # Strategy[] = route(profile, capabilities)
│   ├── capabilities.ts         # runtime detection (browser/node, WebGPU, langs)
│   └── types.ts                # DocumentProfile, RouteStrategy, RuntimeCaps
│
├── worker/                     # NEW — browser Web Worker integration
│   ├── ocr-worker.ts           # the worker entry point
│   ├── worker-client.ts        # main-thread client (postMessage wrapper)
│   └── model-cache.ts          # IndexedDB model caching + lazy download
│
├── ocr/
│   ├── rapidocr.ts             # browser OCR engine (existing)
│   ├── rapidocr-server.ts      # node OCR engine (0.2.0, existing)
│   ├── ocr-space.ts            # REMOVED in 0.3.0
│   ├── vlm.ts                  # VLM engine wrapper (existing)
│   └── granite-docling.ts      # NEW — Granite-Docling-258M engine
│
├── raster/
│   ├── canvas.ts               # browser raster (existing)
│   ├── sharp.ts                # node raster (existing)
│   └── offscreen-canvas.ts     # NEW — OffscreenCanvas for worker
│
├── office.ts                   # docx/xlsx (existing)
├── pdf.ts                      # pdfjs (existing, + getTextContent probe)
└── runtime.ts                  # runtime detection (existing, + WebGPU check)
```

### New Public API

```typescript
// Existing (unchanged)
export { parseDocument } from "./pipeline.ts"

// New: intelligent routing
export { classifyDocument } from "./router/classify.ts"
export { routeDocument } from "./router/route.ts"
export type { DocumentProfile, RuntimeCapabilities } from "./router/types.ts"

// New: Granite-Docling engine
export { createGraniteDoclingEngine } from "./ocr/granite-docling.ts"

// New: Web Worker client
export { createWorkerOcrClient } from "./worker/worker-client.ts"
```

---

## Implementation Phases

### Phase 1: Router Core (liteparse 0.3.0)
- `router/classify.ts` — DocumentProfile classification
- `router/capabilities.ts` — runtime + WebGPU + language detection
- `router/route.ts` — profile → strategy mapping
- Integrate with existing `parseWithFallbacks`
- Tests for classification + routing
- Remove ocr.space engine

### Phase 2: Web Worker (liteparse 0.3.1)
- `worker/ocr-worker.ts` — worker entry point
- `worker/worker-client.ts` — main-thread client
- `worker/model-cache.ts` — IndexedDB caching
- Per-page progress reporting
- WebGPU detection in worker

### Phase 3: Language Management (liteparse 0.3.2)
- Dynamic language model download (Latin + 1)
- IndexedDB cache management
- Script detection from rendered page
- User-context language hint

### Phase 4: Granite-Docling (liteparse 0.4.0)
- `ocr/granite-docling.ts` — engine wrapper
- WebGPU inference (browser)
- ONNX inference (edge)
- Opt-in download + caching
- Cascade integration (RapidOCR → Granite → hosted VLM)

### Phase 5: Studygram Integration
- Replace `clientExtract.ts` with router-based flow
- Classify-on-attach (profile during user typing)
- Configure edge languages
- Deploy edge with Granite-Docling
- Retire parse-document edge function

---

## Key Decisions Summary

| Decision | Rationale |
|----------|-----------|
| Web Worker (not Service Worker) | CPU computation, GPU access, ONNX support |
| English + 1 dynamic language in browser | Small download, covers most users, edge handles rest |
| Remove ocr.space | RapidOCR replaces it fully, no external dependency |
| Granite-Docling between RapidOCR and hosted VLM | Local structure-aware VLM, reduces hosted VLM usage to <5% |
| Docling eager download on first launch, gated on WebGPU | Best local engine always warm when the device can run it; no opt-in friction; no-WebGPU devices route to edge docling |
| Docling NOT in primary path for images | Plain screenshots extract in ~300ms via RapidOCR; escalate to docling (~2–3s) only on low confidence or structure (tables/forms) |
| WebGPU optional, not required | Graceful degradation: WebGPU → 10 pages + Granite; WASM → 3 pages, edge Granite |
| Classify at attach time | Zero latency at send (overlaps with user typing) |
| No separate graphics library | onnxruntime-web WebGPU EP + OffscreenCanvas is sufficient |
| Persistent storage + metered-connection guard on model download | ~130–258MB docling model must survive eviction and not hammer cellular |
