#!/usr/bin/env node
/**
 * Copy onnxruntime-web WASM artifacts to public/ so they're static-served.
 *
 * onnxruntime-web ships .wasm + .mjs files that Rollup cannot bundle — they
 * must be served as static files. This script copies them from node_modules to
 * public/ort/ where Vite dev/prod serves them.
 *
 * Run automatically by `npm postinstall` after `npm install`.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = join(__dirname, "..");
const ORT_SRC = join(ROOT, "node_modules", "onnxruntime-web", "dist");
const ORT_DEST = join(ROOT, "dist", "ort");

// Server-side consumers (e.g. apps/runner installing this package from a
// tarball) have no onnxruntime-web — the browser WASM artifacts don't apply
// there. Skip cleanly instead of crashing their `npm install` (postinstall).
if (!existsSync(ORT_SRC)) {
  console.log("[copy-ort-wasm] onnxruntime-web not installed — skipping (non-browser consumer)");
  process.exit(0);
}

// Ensure destination exists
mkdirSync(ORT_DEST, { recursive: true });

// Copy WASM and JS glue files (ort-wasm.wasm, ort-wasm-simd.wasm, ort-wasm.mjs, etc.)
const files = readdirSync(ORT_SRC);
let copied = 0;
for (const file of files) {
  if (file.endsWith(".wasm") || file.endsWith(".mjs")) {
    const src = join(ORT_SRC, file);
    const dest = join(ORT_DEST, file);
    copyFileSync(src, dest);
    copied++;
    console.log(`[copy-ort-wasm] ${file} → public/ort/`);
  }
}

console.log(`[copy-ort-wasm] Copied ${copied} file(s) to public/ort/`);
