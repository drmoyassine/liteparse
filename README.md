# liteparse

Isomorphic document text extraction — one entry point, runs unchanged in the **browser**, **Node**, and **Deno/edge**.

Extracts text from PDFs (native + OCR + VLM fallback), Office files (`.docx`/`.xlsx`/`.csv`), and images, behind a single `parseDocument()` call. Platform-specific work (image rasterising, OCR, vision-LLM fallback) is done through **swappable adapters** that are auto-detected per runtime, so the same code parses a digital PDF in Node and a scanned passport in the browser.

> **Status:** `0.4.1` fixes the batch-decoder cross-KV threading (Arabic hallucination loops, base-en deaf decode); `0.4.0` ships the linear OCR cascade (pdfjs native text → RapidOCR → VLM fallback) plus the full speech track — audio as a first-class `parseDocument()` kind, local Moonshine STT (EN/AR, browser + self-hosted runner), and live dictation. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [ROADMAP.md](./ROADMAP.md).

## Install

```bash
npm install @drmoyassine/liteparse
# PDF support (optional peer — only if you parse PDFs):
npm install pdfjs-dist
```

Heavy adapters are opt-in (imported only when you use them):
```bash
# Node PDF raster preprocessing — needs both (sharp preprocesses/encodes,
# @napi-rs/canvas is the surface pdfjs renders into):
npm install sharp @napi-rs/canvas
# Node OCR (RapidOCR via onnxruntime-node):
npm install onnxruntime-node
# Browser private OCR (RapidOCR via onnxruntime-web):
npm install onnxruntime-web
```

### Node: local rasterisation + OCR fallback (no VLM round-trip for rendering)

```ts
import { parseDocument } from "@drmoyassine/liteparse";
import { createSharpRaster } from "@drmoyassine/liteparse/raster/sharp";
import { createRapidOcrServerEngine } from "@drmoyassine/liteparse/ocr/rapidocr-server";

const raster = await createSharpRaster();          // dynamically imports sharp + @napi-rs/canvas
const ocrEngine = await createRapidOcrServerEngine(); // loads ONNX models (warm singleton)
const { text } = await parseDocument(pdfFile, { raster, ocrEngine, vlm });
// scanned pages are rasterised locally, OCR'd, then VLM'd as fallback
```

### Low-level: the OCR cascade

For server/edge pipelines that want explicit control over the fallback order, `parseWithFallbacks` runs an ordered list of slots and keeps the first one that yields text:

```ts
import { parseWithFallbacks } from "@drmoyassine/liteparse";
// slots: whole-doc OCR (e.g. ocr.space) → per-page raster+OCR → VLM
```

## Usage

```ts
import { parseDocument } from "@drmoyassine/liteparse";

const result = await parseDocument(file, { filename: "transcript.pdf", maxPages: 20 });
console.log(result.text);
// result.source -> "native" | "ocr" | "vlm" | "mixed"
// result.pages  -> per-page text + source
// result.warnings
```

`parseDocument` **never throws for content problems** — an unparseable file returns `{ text: "", warnings: [...] }`. It throws only on programmer error or abort.

### Injecting a VLM fallback (scanned docs / images)

The vision-LLM gateway is injected, so the library ships zero provider coupling. In the browser, point at your own backend; on the server, use your AI gateway directly:

```ts
import { parseDocument, type VlmGateway } from "@drmoyassine/liteparse";

const vlm: VlmGateway = {
  async readImage(png) {
    const text = await fetch("/api/parse-document/vlm", {
      method: "POST",
      body: png,                       // POST the PNG bytes
    }).then((r) => r.text());
    return text;
  },
};

const { text } = await parseDocument(imageFile, { vlm });
```

See `src/examples/` for a browser gateway and a server gateway (OpenAI-compatible `image_url` block).

## Adapters

| Interface | Browser | Node | Deno/edge |
| --- | --- | --- | --- |
| `RasterAdapter` | Canvas (`OffscreenCanvas`/`<canvas>`) | Sharp (`@drmoyassine/liteparse/raster/sharp`) | none → VLM |
| `OcrEngine` | RapidOCR (runner-injected) or VLM | RapidOCR (`@drmoyassine/liteparse/ocr/rapidocr-server`) or VLM | VLM |
| `VlmGateway` | injected (→ your backend) | injected (→ your AI gateway) | injected |

`ocr: "auto"` (default) uses a registered local OCR engine (browser) when present, else falls back to the VLM gateway when one is supplied, else `none`. Any engine returning empty/error for a page falls through to the VLM gateway when configured.

### Browser: private OCR (RapidOCR / PaddleOCR, no server round-trip)

There is no official RapidOCR npm package, so liteparse wraps a community browser
OCR package (e.g. `client-side-ocr`, `@paddleocr/paddleocr-js` — both run
RapidOCR/PaddleOCR models on `onnxruntime-web`) through an injected runner. Register
it once at app start and `parseDocument` uses it automatically:

```bash
npm install client-side-ocr onnxruntime-web
```

```ts
import { createOCR } from "client-side-ocr";
import { createRapidOcrEngine, setBrowserOcrEngine } from "@drmoyassine/liteparse";

const ocr = await createOCR(); // downloads ONNX models on first use
setBrowserOcrEngine(
  createRapidOcrEngine({
    runner: {
      async recognize(image) {
        const bitmap = await createImageBitmap(new Blob([image], { type: "image/png" }));
        const { text } = await ocr.recognize(bitmap); // adapt to your package's API
        return { text };
      },
    },
  }),
);
```

See `src/examples/rapidocr-runner.browser.ts` for a reusable runner adapter.

## Speech (STT) — Moonshine, EN + AR

`parseDocument()` accepts audio as a first-class kind. Register a local engine
and/or an external gateway; local runs first and escalates on low confidence
(floor 0.55) or failure:

```ts
import {
  parseDocument,
  setBrowserSttEngine,
  createMoonshineSttEngine,
  createMoonshineModelOrigin,
  createServerSttGateway,
} from "@drmoyassine/liteparse";

setBrowserSttEngine(
  createMoonshineSttEngine({ modelOrigin: createMoonshineModelOrigin() }),
); // EN streaming-tiny + AR batch-tiny, ~139 MB, cached in IndexedDB

const stt = createServerSttGateway({
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-transcribe",
}); // optional escalation — resolves { text: "" }, never throws

const { text } = await parseDocument(file, { stt, filename: "note.wav" });
```

Server-side instead: self-host the [parse runner](./apps/runner) and call
`POST /transcribe` — same escalation walk, native speed.

**Self-hosted assets (browser, same-origin):** copy `onnxruntime-web`'s wasm
files to `/ort/` and the Moonshine tokenizer JSONs to `/models/moonshine/`
(the `.ort` weights download from Hugging Face and cache). No COOP/COEP
headers required — single-threaded WASM is the no-headers path.

**Live dictation** — a separate lightweight client, not the parse worker.
Host the two bundles as static assets and inject the worker (long-lived —
don't spawn it per session):

```ts
import { createDictation } from "@drmoyassine/liteparse";

const dictation = createDictation({
  worker: new Worker("<assets>/dictation-worker.js", { type: "module" }), // @drmoyassine/liteparse/stt/dictation-worker
  workletUrl: "<assets>/worklet.js", // @drmoyassine/liteparse/stt/worklet
  language: "ar", // or "en"
  onInterim: (i) => preview(i.text), // ~first at 900 ms, then ≥1.2 s apart
  onFinal: (f) => insert(f.text), // after a ~480 ms pause; "" = gate dropped it
});
await dictation.start({ deviceId }); // or a MediaStream you own
await dictation.stop();
```

Arabic diacritics are stripped by default (`keepDiacritics: true` to keep).
Model variants, latency budget, and the D1/D2 streaming split: [ROADMAP.md](./ROADMAP.md) Track 3.

## Roadmap — Intelligent Document Router (`0.3.0+`)

Today every document runs the same fixed cascade. The router **classifies once** (type, page count, scanned/digital, script/language) **then routes once** to the optimal strategy, replacing brute-force timeout fallback. Highlights:

- **Web Worker** owns the browser OCR pipeline (ONNX + `OffscreenCanvas`, never blocks the UI)
- **Tiered model downloads**: detection + Latin recognition (~16MB) for all devices; Granite-Docling-258M (~130–258MB) for WebGPU devices only
- **Latin + 1 dynamic language** in the browser; all other languages permanently on the edge
- **Granite-Docling-258M** as a local structure-aware VLM between RapidOCR and the hosted VLM, shrinking hosted-VLM usage to <5%
- **ocr.space removed**; RapidOCR replaces it everywhere

➡️ Full design: [ARCHITECTURE.md](./ARCHITECTURE.md) · Build plan (parallelized for multi-agent execution): [ROADMAP.md](./ROADMAP.md)

## Limits

20 MB input · 20 OCR pages · 50k output chars · 30 s per-page abort. VLM fallback is called at most `maxPages` times and reports `warnings: ["vlm_fallback_used:<n> pages"]`.

## License

MIT
