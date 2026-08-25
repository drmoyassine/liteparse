#!/usr/bin/env node
/**
 * Fetch the PP-OCRv4 ONNX artifacts the server OCR engine loads, into
 * ./models/rapidocr/ (gitignored). Prints sha256s — pin them in the Dockerfile's
 * models stage so the image build verifies the same bytes.
 *
 * The dict is NOT fetched: apps/runner/models/ppocr-en-dict.txt is committed
 * (single source shared with the browser bundle); this script copies it next to
 * the fetched det/rec models so RAPIDOCR_MODEL_PATH holds all three.
 *
 * URLs match engines/rapidocr/model-origin-hf.ts (what the browser fetches).
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(HERE, "..", "models", "rapidocr");
const DICT_SRC = resolve(HERE, "..", "models", "ppocr-en-dict.txt");

const ARTIFACTS = [
  {
    // The original Heliososoph/paddleocr-v4-det-onnx repo went 401 upstream (2026-08);
    // breezedeus' conversion of the SAME official ch_PP-OCRv4 mobile det weights is live
    // and same-ecosystem as the rec model. Keep model-origin-hf.ts in sync.
    name: "ch_PP-OCRv4_det_infer.onnx",
    url: "https://huggingface.co/breezedeus/cnstd-ppocr-ch_PP-OCRv4_det/resolve/main/ch_PP-OCRv4_det_infer.onnx",
  },
  {
    name: "en_PP-OCRv4_rec_infer.onnx",
    url: "https://huggingface.co/breezedeus/cnocr-ppocr-en_PP-OCRv4/resolve/main/en_PP-OCRv4_rec_infer.onnx",
  },
];

mkdirSync(MODELS_DIR, { recursive: true });

for (const art of ARTIFACTS) {
  console.log(`→ ${art.name}`);
  const res = await fetch(art.url);
  if (!res.ok) throw new Error(`fetch ${art.url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`${art.name}: suspiciously small (${buf.length}B) — aborting`);
  writeFileSync(resolve(MODELS_DIR, art.name), buf);
  console.log(`  ${art.name}  ${(buf.length / 1024 / 1024).toFixed(1)} MB  sha256=${sha256(buf)}`);
}

copyFileSync(DICT_SRC, resolve(MODELS_DIR, "ppocr-en-dict.txt"));
console.log(`✓ models ready in ${MODELS_DIR}`);
console.log("  (RAPIDOCR_MODEL_PATH should point here; the Dockerfile models stage pins these sha256s)");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
