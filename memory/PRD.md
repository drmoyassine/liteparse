# liteparse 0.6.0 — PRD / status

## Original problem
Add to the existing liteparse library (+ runner): PowerPoint, OpenDocument, RTF, legacy .doc/.xls/.ppt parsing; true per-page PDF processing (real page numbers, method + reason per page, per-page scanned decision) replacing the external wrapper; line-break restoration in native PDF text; corrupted text-layer detection (re-read or flag; optional dictionary); CSV/text encoding detection (Arabic); TIFF/BMP/GIF/WebP → PNG. Approved plan: plan/plan.md (no new OCR engine; Arabic PP-OCRv5 model in existing RapidOCR; browser→runner fallback; vision context; pageOutput; streaming runner; high limits; LibreOffice lazy fallback).

## Architecture
- Library `src/`: classify → route → execute. `src/worker/execute.ts` = per-page cascade core. `src/formats/` pure-JS office readers. `src/text/` encoding, quality, dictionary. `src/image/convert.ts` TIFF decoder + format sniff. `src/ocr/remote.ts` runner OCR client + AMS vision gateway.
- Runner `apps/runner/`: Hono; `/parse` (NDJSON stream | JSON), `/ocr`, `/transcribe`; `libreoffice.ts` lazy/preinstalled converter.

## Implemented (2026-06)
- All Phase 1 items of plan.md. Fixtures: test/fixtures/formats, test/fixtures/v06 (+ make-v06-fixtures.py).
- Tests: library 462 pass; runner 72/75 (3 pre-existing STT failures — Moonshine models not downloaded in this env). Testing agent iteration_1: 33/33 HTTP checks pass.

## Backlog
- P1 (Phase 2): Arabic RapidOCR model in the browser (lazy cached), Markdown structure (slide titles/tables/headings), dictionary tuning + custom lists.
- P2 (Phase 3): confidence-gated earlier vision, real Granite-Docling, EPUB/HTML/Apple iWork, per-page cache.
- Ops: publish LibreOffice archive to the project bucket and set LIBREOFFICE_ARCHIVE_URL/SHA256; mount /data volume.
