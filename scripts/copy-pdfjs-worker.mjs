#!/usr/bin/env node
/**
 * Self-host the pdf.js worker script(s).
 *
 * pdfjs spawns a sub-Worker from `GlobalWorkerOptions.workerSrc`. We previously pointed that at
 * unpkg (cross-origin). Under `Cross-Origin-Embedder-Policy` (needed for onnxruntime-web
 * multi-threaded WASM via SharedArrayBuffer), a cross-origin module worker is unreliable, so we
 * self-host the worker next to the ORT WASM under public/pdf/.
 *
 * Two distinct pdfjs-dist versions coexist in this tree, and each call site must load the worker
 * matching its OWN main-thread pdfjs:
 *   • top-level pdfjs-dist           → used by src/lib/clientExtract.ts + src/workers/liteparse-ocr.worker.ts
 *   • react-pdf's nested pdfjs-dist  → used by src/lib/visa/pdfWorker.ts (react-pdf bundles its own)
 * We stamp each copy with its version (`pdf.worker-<version>.min.mjs`) so the runtime URL built
 * from `pdfjs.version` always resolves to the matching bytes — self-correcting across dep bumps.
 *
 * Run automatically by `npm postinstall` after `npm install` (alongside copy-ort-wasm.mjs).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DEST = join(ROOT, "dist", "pdf");

mkdirSync(DEST, { recursive: true });

// Clear any previously-stamped worker files so stale versions don't accumulate across bumps.
for (const f of readdirSync(DEST)) {
  if (/^pdf\.worker-.*\.min\.mjs$/.test(f)) rmSync(join(DEST, f));
}

/** Copy node_modules/<pkgRoot>/build/pdf.worker.min.mjs → public/pdf/pdf.worker-<version>.min.mjs */
function copyWorker(pkgRoot, label) {
  const workerSrc = join(pkgRoot, "build", "pdf.worker.min.mjs");
  if (!existsSync(workerSrc)) {
    console.warn(`[copy-pdfjs-worker] (${label}) no worker at ${workerSrc} — skipping`);
    return;
  }
  const version = require(join(pkgRoot, "package.json")).version;
  const dest = join(DEST, `pdf.worker-${version}.min.mjs`);
  copyFileSync(workerSrc, dest);
  console.log(`[copy-pdfjs-worker] (${label}) pdfjs-dist@${version} → public/pdf/pdf.worker-${version}.min.mjs`);
}

// 1. Top-level pdfjs-dist (direct import in clientExtract + the OCR worker).
copyWorker(join(ROOT, "node_modules", "pdfjs-dist"), "top-level");

// 2. react-pdf's nested pdfjs-dist (react-pdf bundles its own; only present if not hoisted).
const nested = join(ROOT, "node_modules", "react-pdf", "node_modules", "pdfjs-dist");
if (existsSync(nested)) {
  copyWorker(nested, "react-pdf nested");
} else {
  console.log("[copy-pdfjs-worker] react-pdf uses the hoisted (top-level) pdfjs-dist — no nested copy");
}
