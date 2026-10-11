# liteparse 0.6.0: More Formats, True Per-Page PDFs, Text-Quality Checks

liteparse gains PowerPoint, OpenDocument, RTF and the old .doc/.xls/.ppt formats, and handles every PDF one page at a time through its **existing** cascade (pdfjs text → RapidOCR → Granite-Docling → AMS vision). The external wrapper's fixes (page numbers, line breaks, corrupted text-layer detection, CSV encoding, image conversion) move into liteparse, so the wrapper can be removed.

## Who it's for
- The AMS (the consuming application) and its developers, who call `parseDocument()` in the browser worker or through the self-hosted runner.
- End users who upload long, mixed English/Arabic material: 140+ page PDFs, 130k+ characters, slide decks, legacy Office files.

## Ground rule: no new OCR engine
Every OCR mention in this plan means liteparse's **existing RapidOCR engine**: the browser runner and the server onnxruntime-node engine, with their current confidence gates (0.85 per page, 0.60 per text box). The existing order of steps stays as it is: **pdfjs text → RapidOCR → Granite-Docling → vision step**. Granite-Docling is left exactly as it is today, still a placeholder that passes the page on to the next step. Nothing like Tesseract or a second OCR library is added. The changes are:
- the cascade runs **per page** instead of per document,
- the existing RapidOCR engine gets an **Arabic recognition model**, next to the English one it already loads,
- the vision step receives more context from the AMS.

## Core features and experience

### 1. Per-page cascade (the core change, replaces the wrapper)
Today a digital PDF has all its pages' text joined into a single page, and the scanned-or-digital decision is made once, from pages 1–3. In 0.6.0:
- Each PDF page goes through the cascade on its own: native text first; if that page's text is missing or fails the quality check (section 3), **only that page** is rendered and sent to RapidOCR, then Granite-Docling, then the vision step.
- Every page in the result has its real page number, the method that produced it (`native` / `ocr` / `vlm`) and the reason it went down the cascade.
- A digital PDF with 3 scanned pages runs RapidOCR on those 3 pages only. Document-level `source` becomes `mixed` when pages differ.
- Pages are rendered one at a time, only when needed, not all up front. This keeps memory flat on 140-page files.
- The "first 3 pages" check stays only as a quick early estimate for routing. The real decision is made page by page.
- **Output shape is selectable; processing is always per page.** A `pageOutput: "per-page" (default) | "single"` option controls only how the result is shaped. `"single"` merges all pages into one entry, the shape older callers get today, but still keeps the per-page benefits: only the pages that need OCR get it, and corrupted pages are still re-read. Both shapes produce the same top-level `text`.
  - Browser / library: a per-call option, because environment variables don't exist in the browser.
  - Runner: `RUNNER_PAGE_OUTPUT=per-page|single` sets the default, and a per-request option overrides it.

### 2. Line breaks in native PDF text
- Today the text pieces on a page are joined with nothing between them and all whitespace is collapsed, so words fuse across lines. 0.6.0 uses pdfjs's own end-of-line markers and text positions to put back line breaks, spaces between words, and blank lines between paragraphs.
- Words hyphenated at a line end ("accredi-\ntation") are joined.
- Arabic (right-to-left) lines keep their logical order.
- The same fixed text is used by the early routing check, so its estimates get better too.

### 3. Corrupted text-layer check (native pages)
- Every native page gets a quality score. A page is suspect when it has replacement characters (�), private-use or control glyphs, or symbols/digits inside words above a threshold.
- A suspect page is re-read through the existing cascade (RapidOCR → Granite-Docling → vision). The version that scores better is kept.
- When no OCR or vision is available, the original text is kept and the page is flagged `text_layer_suspect:page_<n>`.
- **Optional dictionary check** (off by default, separate import): English + Arabic word lists that catch letter swaps like "Accrtditation". It flags pages only and never rewrites text. It can also be set to send flagged pages down the cascade.

### 4. Arabic on scanned pages (existing RapidOCR + Arabic model)
- Confirmed: RapidOCR's default models are Chinese/English, and an official **Arabic PP-OCRv5 recognition model** (ONNX + character dictionary, published by RapidAI) is available. It plugs into the existing RapidOCR engine. The text-detection model stays the same, because it works for any language.
- liteparse already maps the `arabic` script to an `ar` recognition model and already has the "Latin + 1 language" browser plan. What is missing is the model itself, which 0.6.0 adds to the runner.
- **Knowing which pages are Arabic:** a scanned page has no text to check, so the script is decided from (a) a language hint passed by the AMS, (b) the script of the document's native pages, or (c) the existing RapidOCR box filter. If a large share of a page's text boxes are thrown away as low-confidence, the page is treated as "unreadable script".
- **Fixes a silent loss that exists today:** on a mixed English/Arabic scan, the English model keeps the English and drops the Arabic boxes as garbage. The page still has enough text to pass, so the Arabic disappears without a warning. In 0.6.0 that page is re-read with the Arabic model (runner) or sent to vision (browser), and the result is flagged.
- Runner: English and Arabic recognition models are both loaded, and each page uses the one that matches its script.
- Browser (Phase 1): pages detected as Arabic skip the local English model and go to the **runner** first, which reads them with the Arabic model. They go to the AMS vision step only if the runner is unavailable or fails. Downloading the Arabic model in the browser is Phase 2.

### 4b. Browser → runner fallback (new)
- The router already marks some RapidOCR steps as "edge" (Arabic or other unavailable script, or more pages than the browser limit of 3 on WASM / 10 on WebGPU). Today that label has no effect: the browser still runs its local English model. In 0.6.0 those pages are actually **sent to the runner**.
- Only the affected pages go, one PNG at a time, and they are read with the runner's RapidOCR (English or Arabic). Everything else stays in the browser.
- The runner's API key can't live in the browser. So, like the vision step, the AMS supplies the connection: either a function, or an AMS URL that adds the key and forwards the request. Each runner call then goes through the AMS's logging and data rules too.
- Order for such a page: **runner RapidOCR → Granite-Docling → AMS vision**. With no runner connection supplied, the order is local RapidOCR or vision, as today. If nothing is available, the page is flagged.
- Why the runner before vision: it is cheaper, faster and more predictable than a vision model, and the page image leaves the device either way. Vision stays the last resort.

### 5. Vision step supplied by the AMS
- What exists today: the vision step is already injected (`vlm.readImage(png, { pageIndex, totalPages, hint, mime })`), and liteparse holds no provider keys. The runner already takes the caller's VLM settings per request and stores nothing.
- 0.6.0 adds context so the AMS can apply its own model settings, logging and data-handling rules: real page number, detected script/language, **reason** (scanned / suspect text layer / Arabic without a local model / OCR low confidence), document name, and the AMS's own request id.
- Runner: alongside today's per-request VLM settings, the AMS can give an **AMS vision endpoint**. The runner then sends each page image to the AMS instead of calling a provider directly, so every vision call goes through the AMS's settings and logs.
- Without a vision step, the pages that needed it are flagged and are never silently left empty.

### 6. New formats
All formats are first read directly in pure JavaScript, the same way in the browser, Node, edge and the runner.

| Format | How the text is read |
| --- | --- |
| .pptx | Slide XML. One page per slide, speaker notes included |
| .odt / .ods / .odp | Document XML. .odp: one page per slide; .ods: one block per sheet |
| .rtf | RTF text reader (Arabic/Unicode escapes and code pages) |
| .xls | The SheetJS reader already used for .xlsx |
| .doc | Pure-JS legacy Word reader (body, headers, footnotes) |
| .ppt | Text records inside the old binary file, through SheetJS's compound-file reader. One page per slide |

- Approach (researched): LlamaIndex LiteParse and Unstructured convert everything with LibreOffice. Apache Tika and POI read old binary formats directly. liteparse reads directly first and uses LibreOffice only as a fallback.
- The current "legacy Office not supported" warning goes away.

**LibreOffice as a lazy fallback (runner only)**
- It is not part of the runner image. It is downloaded the first time a file needs it (an archive of about 95 MB, about 300 MB unpacked, with a small Arabic font set) from the project's own storage bucket, checked against a pinned checksum, then cached on disk.
- It runs only when the direct read fails: an unreadable file such as PowerPoint 95, empty or suspect text, or pictures/scanned content inside the file. The file is converted to PDF and goes through the **same per-page cascade**, so pictures are read by the existing RapidOCR engine.
- The first file that needs it waits about 30–60 seconds; after that, a conversion takes a few seconds.
- Setting: `LIBREOFFICE_MODE = off | lazy (default) | preinstalled`. Browser and edge return a `needs_runner_conversion` warning instead.

### 7. CSV / text encoding
- Today CSV and text are always decoded as UTF-8, so Arabic files saved in Windows encodings come out garbled. 0.6.0 detects the encoding first: UTF-8 with or without BOM, UTF-16, Windows-1256 / ISO-8859-6 for Arabic, and Windows-1252 as the Latin fallback.
- CSV is decoded to correct text **before** the spreadsheet reader sees it. The detected encoding is reported in the result.

### 8. Images
- Before RapidOCR or vision, TIFF (multi-page TIFF becomes one page per frame), BMP, GIF and WebP are converted to PNG through the **existing raster adapters**: sharp in Node, canvas in the browser. TIFF in the browser gets a small decoder because browsers can't open it.

### 9. Large documents and limits
- Gaps today: the browser worker passes no page or character limits at all, and the runner caps requests at 50 OCR pages, 200,000 characters, 20 MB and **110 seconds per request**. A 141-page scan can't finish within that time.
- 0.6.0 sets high, adjustable defaults in the worker and runner: **100 MB input, 300 OCR/vision pages, 2,000,000 characters**. The library defaults (20 MB / 20 pages / 50k) stay for direct callers.
- The existing page budget now counts only pages that actually go through OCR or vision. Native pages are not counted.
- **Page-by-page delivery:**
  - Library: an `onPage` callback.
  - Worker: a new per-page message alongside the existing progress messages.
  - Runner: a streaming response with one page per line, so long documents arrive progressively and no single time limit covers the whole document. The time budget becomes per page.
  - Runner response mode: `RUNNER_RESPONSE_MODE=stream|json` sets the default (`stream`). Each request can override it through its `Accept` header (`application/x-ndjson` or `application/json`). In `json` mode, a document still runs page by page inside the runner, but the overall time limit applies and the caller waits for the full result.
- Reaching a limit always produces a warning (`truncated_pages`, `truncated_chars`).

## User flow
1. The AMS calls `parseDocument(file, { vlm, languageHint, onPage, limits })` in the browser worker, or posts to the runner (optionally with its vision endpoint).
2. liteparse identifies the format. Office/text files are read directly (with LibreOffice as a fallback on the runner). For PDFs and images, each page goes through: native text → quality check → RapidOCR (English or Arabic model) → Granite-Docling → AMS vision.
3. Each finished page is delivered through `onPage` / the worker message / the runner stream, along with its number, method, reason and flags.
4. The final result holds all pages, warnings and encoding/format details. The AMS stops using the wrapper.

## UI/UX feel
No user interface; this is a library and API change.
- One call, predictable per-page output, and warnings code can read (`prefix:detail`).
- It still never throws for content problems, as today.
- The README, ARCHITECTURE and changelog are updated for the change to `pages` and the per-page cascade.

## Implementation phases

### Phase 1 (MVP, built now): release 0.6.0
- Per-page cascade for PDFs, using the existing RapidOCR / Granite-Docling / vision steps, with pages rendered only when needed.
- Line-break, spacing and hyphen rebuilding; Arabic lines kept in order.
- Corrupted text-layer score, with a re-read through the cascade or a flag. Optional dictionary flagging.
- Arabic PP-OCRv5 recognition model added to the existing RapidOCR engine in the runner. Per-page script detection, including the dropped-box signal.
- Browser → runner fallback (AMS-supplied connection) for pages the router marks as "edge", such as Arabic or over the page limit, with vision as the last resort.
- `pageOutput` option and `RUNNER_PAGE_OUTPUT` / `RUNNER_RESPONSE_MODE` settings.
- Vision context (page, script, reason, document name, AMS request id), plus the AMS vision endpoint option on the runner.
- New formats read directly (pptx, odt/ods/odp, rtf, xls, doc, ppt). Lazy LibreOffice fallback in the runner.
- CSV/text encoding detection. TIFF/BMP/GIF/WebP → PNG.
- High worker/runner limits and page-by-page delivery (callback, worker message, runner stream).
- Tests with real samples: an Arabic CSV, a 140-page mixed PDF, a corrupted-layer PDF, a mixed EN/AR scan, and each new format.

### Phase 2
- Arabic RapidOCR model in the browser as a lazy, cached download (the existing "Latin + 1" plan), so Arabic scans stay on the device.
- Structure in the output: slide titles, table rows, headings as Markdown.
- Tuning the dictionary check against real AMS documents, plus custom word lists.

### Phase 3
- Move to vision sooner when RapidOCR confidence is low but not empty (the existing P5 item), and a real Granite-Docling model.
- EPUB, HTML, and Apple Pages/Keynote/Numbers (runner).
- Per-page caching so re-uploads don't re-OCR unchanged pages.

## Assumptions
- "AMS" is the consuming application that owns AI configuration; liteparse only calls what it is given.
- Granite-Docling stays a placeholder in this release (it passes the page on to vision, as today).
- Per-page output is the new default in 0.6.0, and `pageOutput: "single"` gives the old shape. Callers that only read `text` see no change.
- Browser → runner calls go through an AMS-supplied function or proxy URL; the runner key never reaches the browser. The runner's existing image parsing is reused for single pages, with a script hint added.
- Corrupted-page re-reads keep whichever version scores better. With no OCR or vision available, the original text is kept and flagged.
- A page counts as "unreadable script" when at least about 30% of its detected text boxes are thrown away as low-confidence. This will be tuned with real samples.
- The runner's per-request vision settings keep working. The AMS vision endpoint is an addition, not a replacement.
- The runner defaults to a streaming response (`RUNNER_RESPONSE_MODE=stream`). Callers that want one JSON response can ask for it per request, or the runner default can be changed.
- Worker/runner defaults of 100 MB / 300 OCR pages / 2,000,000 characters cover 141 pages and 130k characters comfortably.
- The runner has a persistent disk for the LibreOffice cache. Without one, the download repeats after each restart. A conversion needs about 1–2 GB of memory, so only one runs at a time.
- The runner image grows by about 10 MB (the Arabic model and dictionary). The pure-JS readers add a few hundred KB and load only when one of those formats is opened.
