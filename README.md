# liteparse

Isomorphic document text extraction — one entry point, runs unchanged in the **browser**, **Node**, and **Deno/edge**.

Extracts text from PDFs (native + OCR + VLM fallback), Office files (`.docx`/`.xlsx`/`.csv`), and images, behind a single `parseDocument()` call. Platform-specific work (image rasterising, OCR, vision-LLM fallback) is done through **swappable adapters** that are auto-detected per runtime, so the same code parses a digital PDF in Node and a scanned passport in the browser.

> **Status:** `0.2.0` ships the linear OCR cascade (pdfjs native text → ocr.space / RapidOCR → VLM fallback) with the Node `rapidocr-server` runner. The next major work is the **Intelligent Document Router** (`0.3.0+`) — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [ROADMAP.md](./ROADMAP.md) for the parallelizable build plan.

## Install

```bash
npm install liteparse
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
import { parseDocument } from "liteparse";
import { createSharpRaster } from "liteparse/raster/sharp";
import { createRapidOcrServerEngine } from "liteparse/ocr/rapidocr-server";

const raster = await createSharpRaster();          // dynamically imports sharp + @napi-rs/canvas
const ocrEngine = await createRapidOcrServerEngine(); // loads ONNX models (warm singleton)
const { text } = await parseDocument(pdfFile, { raster, ocrEngine, vlm });
// scanned pages are rasterised locally, OCR'd, then VLM'd as fallback
```

### Low-level: the OCR cascade

For server/edge pipelines that want explicit control over the fallback order, `parseWithFallbacks` runs an ordered list of slots and keeps the first one that yields text:

```ts
import { parseWithFallbacks } from "liteparse";
// slots: whole-doc OCR (e.g. ocr.space) → per-page raster+OCR → VLM
```

## Usage

```ts
import { parseDocument } from "liteparse";

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
import { parseDocument, type VlmGateway } from "liteparse";

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
| `RasterAdapter` | Canvas (`OffscreenCanvas`/`<canvas>`) | Sharp (`liteparse/raster/sharp`) | none → VLM |
| `OcrEngine` | RapidOCR (runner-injected) or VLM | RapidOCR (`liteparse/ocr/rapidocr-server`) or VLM | VLM |
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
import { createRapidOcrEngine, setBrowserOcrEngine } from "liteparse";

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
