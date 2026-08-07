# liteparse

Isomorphic document text extraction — one entry point, runs unchanged in the **browser**, **Node**, and **Deno/edge**.

Extracts text from PDFs (native + OCR + VLM fallback), Office files (`.docx`/`.xlsx`/`.csv`), and images, behind a single `parseDocument()` call. Platform-specific work (image rasterising, OCR, vision-LLM fallback) is done through **swappable adapters** that are auto-detected per runtime, so the same code parses a digital PDF in Node and a scanned passport in the browser.

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
# Browser private OCR (RapidOCR via onnxruntime-web):
npm install onnxruntime-web
```

### Node: local rasterisation + OCR fallback (no VLM round-trip for rendering)

```ts
import { parseDocument } from "liteparse";
import { createSharpRaster } from "liteparse/raster/sharp";

const raster = await createSharpRaster(); // dynamically imports sharp + @napi-rs/canvas
const { text } = await parseDocument(pdfFile, { raster, vlm });
// scanned pages are rasterised locally, OCR'd (engine permitting), then VLM'd as fallback
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
  async readImage(png, hint) {
    const text = await fetch("/api/parse-document/vlm", {
      method: "POST",
      body: png,                       // POST the PNG bytes
    }).then((r) => r.text());
    return text;
  },
};

const { text } = await parseDocument(imageFile, { vlm });
```

See `src/examples/` for a browser gateway and a server gateway (Vercel AI SDK / OpenAI-compatible `image_url` block).

## Adapters

| Interface | Browser | Node | Deno/edge |
| --- | --- | --- | --- |
| `RasterAdapter` | Canvas (`OffscreenCanvas`/`<canvas>`) | Sharp (`liteparse/raster/sharp`) | none → VLM |
| `OcrEngine` | RapidOCR (`liteparse/ocr/rapidocr`) or VLM | VLM | VLM |
| `VlmGateway` | injected (→ your backend) | injected (→ your AI gateway) | injected |

`ocr: "auto"` (default) picks RapidOCR when registered + browser, else VLM when a gateway is supplied, else `none`. Any engine returning empty/error for a page falls through to the VLM gateway when configured.

## Limits

20 MB input · 20 OCR pages · 50k output chars · 30 s per-page abort. VLM fallback is called at most `maxPages` times and reports `warnings: ["vlm_fallback_used:<n> pages"]`.

## License

MIT
