# Changelog

## 0.6.0

### Breaking
- `ParsedDocument.pages` is now **one entry per real page** for PDFs (and per slide / TIFF frame). Pass `pageOutput: "single"` to get the pre-0.6 single-entry shape; `text` is identical in both shapes.
- `Page` gains `pageNumber`, `method`, `engine`, `reason`, `script`, `quality`, `flags`. Document `source` is `mixed` when pages differ.
- Legacy `.doc/.xls/.ppt` are no longer `kind: "other"` with `legacy_office_not_supported`; they are parsed (`kind: "doc" | "xls" | "ppt"`).
- Native PDF text keeps line breaks and paragraph gaps (previously all whitespace was collapsed to single spaces).

### Added
- Per-page PDF cascade (`pdfjs text → RapidOCR → Granite-Docling → vision`), rendering only pages that need it; the OCR page budget counts OCR/vision pages only.
- Line/space/paragraph rebuilding from pdfjs `hasEOL` + positions, hyphen re-joining, RTL logical order (`rebuildPageText`).
- Text-layer quality check (`scoreTextLayer`) with re-read-or-flag (`text_layer_suspect:page_<n>`); optional dictionary check (`@drmoyassine/liteparse/dictionary`).
- Arabic PP-OCRv5 recognition model in the server RapidOCR engine (`scripts: ["latin","arabic"]`, `ctx.script`), weak/dropped-box statistics, mixed EN/AR box re-reads.
- Browser → runner OCR fallback (`runnerOcr`, `createRunnerOcrEngine`) and AMS vision endpoint (`createVisionEndpointGateway`); vision calls now receive `pageNumber`, `script`, `language`, `reason`, `documentName`, `requestId`.
- Formats: `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf`, `.doc`, `.xls`, `.ppt` (pure JS); `convertToPdf` hook for the runner's LibreOffice fallback; `needs_runner_conversion:<kind>` elsewhere.
- CSV/text encoding detection (UTF-8/BOM, UTF-16, windows-1256, iso-8859-6, windows-1252) reported as `meta.encoding`.
- TIFF (multi-frame) / BMP / GIF / WebP → PNG via `RasterAdapter.imageToPng` (sharp in Node, canvas + a pure-JS TIFF decoder in the browser).
- Page-by-page delivery: `onPage`, worker `{type:"page"}` messages (idle job timeout), runner NDJSON stream.
- Worker defaults 300 OCR pages / 2,000,000 chars; runner 100 MB / 300 / 2,000,000.

### Runner 0.4.0
- `RUNNER_RESPONSE_MODE` (stream|json, `Accept` override), `RUNNER_PAGE_OUTPUT`, `RUNNER_MAX_PAGE_MS`, `RUNNER_MAX_OCR_PAGES`, `RUNNER_MAX_CHARS`, `LIBREOFFICE_*`.
- `POST /ocr` (single page, script-selected model), `options.vlmEndpoint`, `options.languageHint`, `options.requestId`, `pages`/`encoding`/`format` in responses.
- Image ships the Arabic PP-OCRv5 rec model (+~8 MB) and dictionary.
