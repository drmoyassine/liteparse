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

/**
 * [subdir, filename, url, expectedMiB, minBytes?] — sizes measured 2026-09-01
 * (AR streaming 2026-09-02). minBytes overrides the 500 KB small-file guard
 * for legitimately tiny artifacts (the AR frontend GRAPH is 23 KB — its
 * weights ship separately; the Dockerfile sha256s are the real integrity pin).
 */
const ARTIFACTS = [
  // EN slot 1 — moonshine-ai/moonshine-streaming onnx/tiny (MIT; stateful .ort)
  ["streaming-tiny-en", "frontend.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/frontend.ort", 7.9],
  ["streaming-tiny-en", "encoder.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/encoder.ort", 7.2],
  ["streaming-tiny-en", "adapter.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/adapter.ort", 5.0],
  ["streaming-tiny-en", "cross_kv.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/cross_kv.ort", 1.2],
  ["streaming-tiny-en", "decoder_kv.ort", "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/decoder_kv.ort", 90.9],
  // AR slot 1 — OFFICIAL Useful Sensors artifacts (quantized_26_08_24),
  // fetched from our byte-identical HF mirror (the official CDN sends no CORS
  // headers; MIT — the streaming family is MIT per the upstream LICENSE,
  // verified 2026-09-03): decode long clips cleanly where every HF-checkpoint
  // export looped past ~2 s. The frontend ships as graph + weights pair
  // (bindFrontendWeights in shared/decode.ts).
  ["streaming-tiny-ar", "frontend.model.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/frontend.model.ort", 0.022, 20_000],
  ["streaming-tiny-ar", "frontend.weights.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/frontend.weights.ort", 2.0],
  ["streaming-tiny-ar", "encoder.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/encoder.ort", 7.4],
  ["streaming-tiny-ar", "adapter.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/adapter.ort", 1.3],
  ["streaming-tiny-ar", "cross_kv.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/cross_kv.ort", 1.2],
  ["streaming-tiny-ar", "decoder_kv.ort", "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/decoder_kv.ort", 18.8],
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
  "streaming-tiny-ar/tokenizer.json",
  "streaming-tiny-ar/streaming_config.json",
  "batch-base-en/tokenizer.json",
]) {
  if (!existsSync(resolve(MODELS_DIR, sidecar))) {
    throw new Error(`missing committed sidecar: models/moonshine/${sidecar} — check out the repo cleanly`);
  }
}

let total = 0;
for (const [dir, name, url, expectedMiB, minBytes = 500_000] of ARTIFACTS) {
  const dest = resolve(MODELS_DIR, dir, name);
  const cached = existsSync(dest) ? readFileSync(dest) : null;
  if (cached && cached.length >= minBytes) {
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
  // here is ≥ 1 MB except the AR frontend GRAPH (23 KB — weights ship next to
  // it; its per-row minBytes catches a truncated/error-page download).
  if (buf.length < minBytes) throw new Error(`${name}: suspiciously small (${buf.length}B) — aborting`);
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
