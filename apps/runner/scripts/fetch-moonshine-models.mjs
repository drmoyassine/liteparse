#!/usr/bin/env node
/**
 * Fetch the Moonshine ONNX/ORT artifacts the server STT engine loads, into
 * ./models/moonshine/ (gitignored for binaries). Prints sha256s — pin them in
 * the Dockerfile's models stage so the image build verifies the same bytes.
 *
 * The tokenizer.json / streaming_config.json sidecars are NOT fetched: they're
 * committed (models/moonshine/<dir>/*.json), same policy as the OCR dict — HF
 * resolve URLs are mutable, and a silently-updated tokenizer would decode every
 * transcript into garbage while every hash-checked binary stays "valid".
 *
 * URLs + layout mirror src/engines/moonshine/shared/models.ts (the single
 * source of truth — keep in sync).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(HERE, "..", "models", "moonshine");

/** [subdir, filename, url, expectedMiB] — sizes measured 2026-09-01 (MiB). */
const ARTIFACTS = [
  // EN slot 1 — moonshine-ai/moonshine-streaming onnx/tiny (MIT; stateful .ort)
  ["streaming-tiny-en", "frontend.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/frontend.ort", 7.9],
  ["streaming-tiny-en", "encoder.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/encoder.ort", 7.2],
  ["streaming-tiny-en", "adapter.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/adapter.ort", 5.0],
  ["streaming-tiny-en", "cross_kv.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/cross_kv.ort", 1.2],
  ["streaming-tiny-en", "decoder_kv.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/decoder_kv.ort", 90.9],
  // AR slot 1 — onnx-community/moonshine-tiny-ar-ONNX int8 (license "other":
  // fetch/bake freely, never npm-redistribute — noted in shared/models.ts)
  ["batch-tiny-ar", "encoder_model_int8.onnx", "https://huggingface.co/onnx-community/moonshine-tiny-ar-ONNX/resolve/main/onnx/encoder_model_int8.onnx", 7.6],
  ["batch-tiny-ar", "decoder_model_merged_int8.onnx", "https://huggingface.co/onnx-community/moonshine-tiny-ar-ONNX/resolve/main/onnx/decoder_model_merged_int8.onnx", 19.4],
  // EN slot 2 — onnx-community/moonshine-base-ONNX int8 (MIT)
  ["batch-base-en", "encoder_model_int8.onnx", "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model_int8.onnx", 19.5],
  ["batch-base-en", "decoder_model_merged_int8.onnx", "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/decoder_model_merged_int8.onnx", 40.5],
];

for (const [dir] of ARTIFACTS) mkdirSync(resolve(MODELS_DIR, dir), { recursive: true });

// The committed sidecars must already sit next to the binaries (the engine
// loads them from the same dirs).
for (const sidecar of [
  "streaming-tiny-en/tokenizer.json",
  "streaming-tiny-en/streaming_config.json",
  "batch-tiny-ar/tokenizer.json",
  "batch-base-en/tokenizer.json",
]) {
  if (!existsSync(resolve(MODELS_DIR, sidecar))) {
    throw new Error(`missing committed sidecar: models/moonshine/${sidecar} — check out the repo cleanly`);
  }
}

let total = 0;
for (const [dir, name, url, expectedMiB] of ARTIFACTS) {
  const dest = resolve(MODELS_DIR, dir, name);
  const cached = existsSync(dest) ? readFileSync(dest) : null;
  if (cached && cached.length >= 500_000) {
    // Resumable: a previously fetched binary is hashed as-is (the Dockerfile
    // pins these hashes, so a mismatched local copy fails the image build).
    total += cached.length;
    console.log(`  ${name}  (cached)  ${(cached.length / 1048576).toFixed(1)} MB  sha256=${sha256(cached)}`);
    continue;
  }
  console.log(`→ ${dir}/${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Size guard against a proxy/HTML error page saved as a model: every binary
  // here is ≥ 1 MB (cross_kv.ort, the smallest, is ~1.26 MB).
  if (buf.length < 500_000) throw new Error(`${name}: suspiciously small (${buf.length}B) — aborting`);
  const mib = buf.length / 1024 / 1024;
  if (expectedMiB && Math.abs(mib - expectedMiB) / expectedMiB > 0.25) {
    throw new Error(`${name}: ${mib.toFixed(1)} MiB deviates >25% from the expected ${expectedMiB} — upstream artifact changed?`);
  }
  writeFileSync(dest, buf);
  total += buf.length;
  console.log(`  ${name}  ${mib.toFixed(1)} MB  sha256=${sha256(buf)}`);
}

console.log(`✓ models ready in ${MODELS_DIR} (${(total / 1024 / 1024).toFixed(0)} MB total)`);
console.log("  (MOONSHINE_MODEL_PATH should point here, or run from apps/runner; the Dockerfile models stage pins these sha256s)");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
