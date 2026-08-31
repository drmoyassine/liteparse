#!/usr/bin/env node
/**
 * Track 3 Phase B.1 — Moonshine artifact spike (kill-switch). Standalone:
 * imported by nothing; safe to delete once the findings are recorded in
 * ROADMAP.md Track 3 "Artifact status".
 *
 * Answers the three questions the engine code must not guess at:
 *   1. Can onnxruntime-node load the streaming `.ort` graphs — from a Buffer
 *      AND from a path? Can it load classic onnx-community `.onnx` from bytes?
 *   2. Can onnxruntime-web/wasm load `.ort` from bytes under Node? (This is
 *      Phase C's entry criterion — same subpath import the browser engine uses.)
 *   3. What are the graphs' I/O signatures — raw waveform vs precomputed
 *      features, logits vs argmax-only decoders, KV/state cache tensors, and
 *      does the streaming frontend's feature output FIT the batch
 *      (onnx-community) encoder input? (If yes, AR batch models get a mel
 *      frontend for free instead of a hand-written one in shared/audio.ts.)
 *
 * Downloads into .spike-moonshine/ (gitignored) on first run; reuses cache.
 *
 * Artifact ground truth (HF API, verified 2026-09-01):
 *   - moonshine-ai/moonshine-streaming onnx/tiny/*.ort (MIT) — EN streaming
 *     graph set: frontend / encoder / decoder / decoder_kv / cross_kv / adapter.
 *   - moonshine-streaming-tiny-ar EXISTS (MIT) but ships PyTorch only — no
 *     ONNX export anywhere. Arabic's local slot is therefore the BATCH
 *     onnx-community/moonshine-tiny-ar-ONNX export (license "other": never
 *     redistributed via npm; runner bakes it, browser fetches from HF).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_DIR = resolve(HERE, "..", ".spike-moonshine");
const require = createRequire(import.meta.url);

const STREAM_BASE =
  "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny";
const AR_BASE = "https://huggingface.co/onnx-community/moonshine-tiny-ar-ONNX/resolve/main";

// [url-suffix, local-name, min-bytes sanity floor]
const ARTIFACTS = [
  ["frontend.ort", "frontend.ort", 10_000],
  ["encoder.ort", "encoder.ort", 10_000],
  ["decoder.ort", "decoder.ort", 10_000],
  ["decoder_kv.ort", "decoder_kv.ort", 10_000],
  ["cross_kv.ort", "cross_kv.ort", 1_000],
  ["adapter.ort", "adapter.ort", 1_000],
  ["tokenizer.json", "tokenizer.json", 100],
  ["streaming_config.json", "streaming_config.json", 100],
  ["onnx/encoder_model_int8.onnx", "ar-encoder_model_int8.onnx", 1_000_000],
  ["onnx/decoder_model_merged_int8.onnx", "ar-decoder_model_merged_int8.onnx", 1_000_000],
];

// ─── results plumbing ────────────────────────────────────────────────────────

const results = [];
const sig = {}; // signature facts, surfaced in the final ANSWER 3 digest

function record(id, label, ok, note = "") {
  results.push({ id, label, ok, note });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${note ? ` — ${note}` : ""}`);
}

function fmtBytes(n) {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/** Race a promise against a deadline so a hung load can't hang the spike. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Print input/output names (+ metadata shapes when the binding exposes them). */
function describeSession(s, ort) {
  const meta = (names, m) =>
    names
      .map((n) => {
        const e = m?.[n];
        return e ? `${n}:${e.shape ? JSON.stringify(e.shape) : "?"}(${e.tensorType ?? e.type ?? "?"})` : n;
      })
      .join(", ");
  console.log(`      inputs : ${meta(s.inputNames, s.inputMetadata)}`);
  console.log(`      outputs: ${meta(s.outputNames, s.outputMetadata)}`);
}

function tensorSummary(t) {
  const data = t.data instanceof Float32Array ? t.data : null;
  let stats = "";
  if (data && data.length) {
    let min = Infinity,
      max = -Infinity,
      sum = 0;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    stats = ` min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${(sum / data.length).toFixed(3)}`;
  }
  return `${t.type}${JSON.stringify(t.dims)}${stats}`;
}

/** 1s of 440 Hz sine @16 kHz — real values, unlike silence. */
function sineWave(seconds = 1, rate = 16_000, freq = 440, amp = 0.1) {
  const n = Math.floor(seconds * rate);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return f;
}

// ─── 0. download artifacts ───────────────────────────────────────────────────

console.log("→ downloading artifacts (cached under apps/runner/.spike-moonshine/)");
mkdirSync(SPIKE_DIR, { recursive: true });
let downloaded = 0;
for (const [suffix, name, minBytes] of ARTIFACTS) {
  const dest = resolve(SPIKE_DIR, name);
  if (existsSync(dest) && statSync(dest).size >= minBytes) continue;
  const url = suffix.startsWith("onnx/") ? `${AR_BASE}/${suffix}` : `${STREAM_BASE}/${suffix}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`${name}: suspiciously small (${buf.length}B) — aborting`);
  writeFileSync(dest, buf);
  downloaded++;
  console.log(
    `  ${name}  ${fmtBytes(buf.length)}  sha256=${createHash("sha256").update(buf).digest("hex").slice(0, 16)}…`,
  );
}
if (!downloaded) console.log("  (all cached)");

const ortNodeVersion = safeVersion("onnxruntime-node");
const ortWebDist = resolveOrtWebDist();
const ortWebVersion = ortWebDist
  ? safeReadVersion(join(ortWebDist, "..", "package.json"))
  : "not-resolvable";
console.log(
  `\n  onnxruntime-node ${ortNodeVersion} (apps/runner local) · onnxruntime-web ${ortWebVersion} (${ortWebDist ?? "NOT FOUND"})`,
);

function safeVersion(pkg) {
  try {
    return safeReadVersion(require.resolve(`${pkg}/package.json`));
  } catch {
    return "not-resolvable";
  }
}
function safeReadVersion(pkgJsonPath) {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}
/**
 * onnxruntime-web's exports map does NOT expose ./package.json, so
 * require.resolve("onnxruntime-web/package.json") throws — resolve the exported
 * ./wasm subpath instead (dist/ort-wasm.mjs), falling back to the known root
 * devDependency location.
 */
function resolveOrtWebDist() {
  try {
    const dir = dirname(require.resolve("onnxruntime-web/wasm")); // …/dist/ort-wasm.mjs
    if (dir.endsWith("dist")) return dir;
  } catch {
    /* fall through to the root guess */
  }
  const guess = resolve(HERE, "..", "..", "..", "node_modules", "onnxruntime-web", "dist");
  return existsSync(guess) ? guess : null;
}

// ─── 1. onnxruntime-node: `.ort` buffer + path, classic `.onnx` buffer ──────

console.log("\n[1] onnxruntime-node — streaming .ort (buffer AND path), classic .onnx (buffer)");
const ortNode = await import("onnxruntime-node");
const P = (name) => resolve(SPIKE_DIR, name);
const B = (name) => new Uint8Array(readFileSync(P(name)));

let frontendNode = null;
let encoderNode = null;
let adapterNode = null;
let crossKvNode = null;
let arEncoderNode = null;

// 1a. buffer-load every streaming .ort graph
for (const name of ["frontend.ort", "encoder.ort", "decoder.ort", "decoder_kv.ort", "cross_kv.ort", "adapter.ort"]) {
  try {
    const s = await withTimeout(ortNode.InferenceSession.create(B(name)), 30_000, `buffer ${name}`);
    describeSession(s, ortNode);
    if (name === "frontend.ort") frontendNode = s;
    if (name === "encoder.ort") encoderNode = s;
    if (name === "adapter.ort") adapterNode = s;
    if (name === "cross_kv.ort") crossKvNode = s;
    if (name === "decoder.ort") sig.streamDecoderOut = s.outputNames.join(",");
    if (name === "decoder_kv.ort") sig.kvTensors = s.inputNames.join(",");
    record(`node-buffer-${name}`, `node buffer-load ${name}`, true);
  } catch (err) {
    record(`node-buffer-${name}`, `node buffer-load ${name}`, false, err.message);
  }
}

// 1b. path-load the encoder (the documented-reliable route for .ort)
try {
  const s = await withTimeout(ortNode.InferenceSession.create(P("encoder.ort")), 30_000, "path encoder.ort");
  record("node-path-encoder", "node path-load encoder.ort", true);
} catch (err) {
  record("node-path-encoder", "node path-load encoder.ort", false, err.message);
}

// 1c. classic onnx-community .onnx from bytes (the AR batch artifacts)
try {
  const s = await withTimeout(ortNode.InferenceSession.create(B("ar-encoder_model_int8.onnx")), 30_000, "buffer ar-encoder");
  describeSession(s, ortNode);
  sig.arEncoderIn = s.inputNames.join(",");
  arEncoderNode = s;
  record("node-classic-ar-encoder", "node buffer-load ar encoder_model_int8.onnx", true);
} catch (err) {
  record("node-classic-ar-encoder", "node buffer-load ar encoder_model_int8.onnx", false, err.message);
}
try {
  const s = await withTimeout(
    ortNode.InferenceSession.create(B("ar-decoder_model_merged_int8.onnx")),
    30_000,
    "buffer ar-decoder",
  );
  describeSession(s, ortNode);
  sig.arDecoderOut = s.outputNames.join(",");
  record("node-classic-ar-decoder", "node buffer-load ar decoder_model_merged_int8.onnx", true);
} catch (err) {
  record("node-classic-ar-decoder", "node buffer-load ar decoder_model_merged_int8.onnx", false, err.message);
}

// ─── 2. run-level probes: waveform → frontend → encoder → adapter/cross_kv ───

console.log("\n[2] run probes — the EN chain end-to-end (minus decoder), AR encoder on raw audio");

/** Zero tensor of the given ort dtype (ort-node requires the exact typed array). */
function zeroTensor(ort, type, dims) {
  const n = dims.reduce((a, b) => a * b, 1);
  const data =
    type === "int64"
      ? new BigInt64Array(n)
      : type === "int32"
        ? new Int32Array(n)
        : new Float32Array(n);
  return new ort.Tensor(type, data, dims);
}

if (frontendNode) {
  // streaming_config.json carries the exact frontend state shapes — zero-init them.
  const cfg = JSON.parse(readFileSync(P("streaming_config.json"), "utf8"));
  const st = cfg.frontend_state_shapes;
  const wave = sineWave(0.1); // 100 ms = 1600 samples @16 kHz
  let frontendOut = null;
  for (const intType of ["int64", "int32"]) {
    try {
      const feed = {
        audio_chunk: new ortNode.Tensor("float32", wave, [1, wave.length]),
        sample_buffer: zeroTensor(ortNode, "float32", st.sample_buffer),
        sample_len: zeroTensor(ortNode, intType, st.sample_len),
        conv1_buffer: zeroTensor(ortNode, "float32", st.conv1_buffer),
        conv2_buffer: zeroTensor(ortNode, "float32", st.conv2_buffer),
        frame_count: zeroTensor(ortNode, intType, st.frame_count),
      };
      frontendOut = await withTimeout(frontendNode.run(feed), 60_000, "frontend run");
      sig.frontendIn = `audio_chunk float32 [1,${wave.length}] + 5 state inputs (${intType} counters) — frame_len=${cfg.frame_len}, lookahead=${cfg.total_lookahead}`;
      break;
    } catch (err) {
      console.log(`      (int64 counters rejected: ${err.message.slice(0, 120)})`);
    }
  }
  if (frontendOut) {
    for (const [name, t] of Object.entries(frontendOut)) {
      console.log(`      ${name} → ${tensorSummary(t)}`);
      if (name === "features") sig.frontendOut = tensorSummary(t);
    }
    record("frontend-run", "frontend.ort run with config-shaped zero state", true);

    // encoder(features) → encoded
    let encoded = null;
    if (encoderNode && frontendOut.features) {
      try {
        const enc = await withTimeout(encoderNode.run({ features: frontendOut.features }), 60_000, "encoder run");
        encoded = enc.encoded ?? Object.values(enc)[0];
        sig.encoderOut = `encoded ${tensorSummary(encoded)}`;
        console.log(`      encoded → ${tensorSummary(encoded)}`);
        record("encoder-run", "streaming encoder consumes frontend features", true);
      } catch (err) {
        record("encoder-run", "streaming encoder consumes frontend features", false, err.message.slice(0, 160));
      }
    }
    // adapter(encoded, pos_offset) → memory · cross_kv(memory) → k/v_cross
    if (encoded) {
      let memory = null;
      if (adapterNode) {
        try {
          const out = await withTimeout(
            adapterNode.run({ encoded, pos_offset: zeroTensor(ortNode, "int64", [1]) }),
            60_000,
            "adapter run",
          );
          memory = out.memory ?? Object.values(out)[0];
          sig.adapterOut = `memory ${tensorSummary(memory)}`;
          console.log(`      adapter → ${sig.adapterOut}`);
          record("adapter-run", "adapter.ort consumes encoder output", true);
        } catch (err) {
          record("adapter-run", "adapter.ort consumes encoder output", false, err.message.slice(0, 160));
        }
      }
      if (crossKvNode && memory) {
        try {
          const out = await withTimeout(crossKvNode.run({ memory }), 60_000, "cross_kv run");
          const first = Object.entries(out)[0];
          console.log(`      cross_kv → ${first?.[0]} ${tensorSummary(first?.[1])}`);
          sig.crossKvOut = Object.keys(out).map((k) => `${k} ${tensorSummary(out[k])}`).join(" · ");
          record("cross_kv-run", "cross_kv.ort consumes adapter memory", true);
        } catch (err) {
          record("cross_kv-run", "cross_kv.ort consumes adapter memory", false, err.message.slice(0, 160));
        }
      }
    }
  } else {
    record("frontend-run", "frontend.ort run with config-shaped zero state", false, "int64 and int32 counters both rejected");
  }
} else {
  record("frontend-run", "frontend.ort run with config-shaped zero state", false, "frontend not loaded");
}

// AR batch encoder: onnx-community exports name the waveform input `input_values` —
// run it on the same sine to confirm the ConvFrontend is INSIDE the batch encoder.
if (arEncoderNode) {
  try {
    const wave = sineWave(1);
    const out = await withTimeout(
      arEncoderNode.run({ input_values: new ortNode.Tensor("float32", wave, [1, wave.length]) }),
      60_000,
      "AR encoder run",
    );
    const first = Object.entries(out)[0];
    sig.arEncoderOut = `${first?.[0]} ${tensorSummary(first?.[1])}`;
    console.log(`      ar-encoder → ${sig.arEncoderOut}`);
    record("ar-encoder-run", "AR batch encoder eats raw waveform (input_values)", true);
  } catch (err) {
    record("ar-encoder-run", "AR batch encoder eats raw waveform (input_values)", false, err.message.slice(0, 160));
  }
}

// ─── 3. onnxruntime-web/wasm under Node (Phase C entry criterion) ────────────

console.log("\n[3] onnxruntime-web/wasm under Node — the exact import the browser engine uses");
try {
  const ortWeb = await import("onnxruntime-web/wasm");
  if (!ortWebDist) throw new Error("onnxruntime-web dist dir not found (is the root devDep installed?)");
  ortWeb.env.wasm.numThreads = 1; // Phase C parity: no crossOriginIsolated
  ortWeb.env.wasm.proxy = false;
  ortWeb.env.wasm.wasmPaths = pathToFileURL(ortWebDist).href + "/";
  const distNote = `wasmPaths=${ortWeb.env.wasm.wasmPaths}`;
  try {
    const s = await withTimeout(ortWeb.InferenceSession.create(B("encoder.ort")), 60_000, "web encoder.ort");
    describeSession(s, ortWeb); // web sessions may expose dims metadata that ort-node lacks
    record("web-ort-encoder", "web/wasm buffer-load encoder.ort", true, distNote);
  } catch (err) {
    record("web-ort-encoder", "web/wasm buffer-load encoder.ort", false, `${distNote} — ${err.message.slice(0, 160)}`);
  }
  try {
    const s = await withTimeout(ortWeb.InferenceSession.create(B("decoder_kv.ort")), 60_000, "web decoder_kv.ort");
    describeSession(s, ortWeb);
    record("web-ort-decoder-kv", "web/wasm buffer-load decoder_kv.ort", true, distNote);
  } catch (err) {
    record("web-ort-decoder-kv", "web/wasm buffer-load decoder_kv.ort", false, err.message.slice(0, 160));
  }
  try {
    const s = await withTimeout(ortWeb.InferenceSession.create(B("ar-encoder_model_int8.onnx")), 60_000, "web ar-encoder");
    describeSession(s, ortWeb);
    record("web-classic-ar", "web/wasm buffer-load ar encoder .onnx", true);
  } catch (err) {
    record("web-classic-ar", "web/wasm buffer-load ar encoder .onnx", false, err.message.slice(0, 160));
  }
} catch (err) {
  record("web-ort-encoder", "web/wasm buffer-load encoder.ort", false, `import failed: ${err.message.slice(0, 160)}`);
  record("web-ort-decoder-kv", "web/wasm buffer-load decoder_kv.ort", false, "import failed");
  record("web-classic-ar", "web/wasm buffer-load ar encoder .onnx", false, "import failed");
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log("\n──────────────────── spike summary ────────────────────");
const nodeOrtBufferOk = results.filter((r) => r.id.startsWith("node-buffer-")).every((r) => r.ok);
const nodeOrtPathOk = results.find((r) => r.id === "node-path-encoder")?.ok;
const classicOk = results.filter((r) => r.id.startsWith("node-classic-")).every((r) => r.ok);
const webOrtOk = results.find((r) => r.id === "web-ort-encoder")?.ok;
console.log(`ANSWER 1  ort-node .ort buffer: ${nodeOrtBufferOk ? "YES" : "NO"} · path: ${nodeOrtPathOk ? "YES" : "NO"} · classic .onnx bytes: ${classicOk ? "YES" : "NO"}`);
console.log(`ANSWER 2  ort-web/wasm under Node, .ort from bytes: ${webOrtOk ? "YES (Phase C viable)" : "NO (Phase C falls back to classic .onnx)"}`);
console.log(`ANSWER 3  frontend eats: ${sig.frontendIn ?? "?"}`);
console.log(`          frontend emits: ${sig.frontendOut ?? "?"}`);
console.log(`          streaming encoder emits: ${sig.encoderOut ?? "?"}`);
console.log(`          streaming decoder outputs: ${sig.streamDecoderOut ?? "?"} · KV/state inputs: ${sig.kvTensors ?? "?"}`);
console.log(`          AR batch encoder inputs: ${sig.arEncoderIn ?? "?"} → emits: ${sig.arEncoderOut ?? "?"}`);
console.log(`          AR decoder outputs: ${sig.arDecoderOut ?? "?"}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} experiment(s) failed — see FAIL lines above.` : "\nall experiments passed");
