/**
 * Decode probe — instrumented Moonshine loops against real corpus clips.
 * Standalone diagnostic (spike-moonshine.mjs precedent); NOT shipped, delete
 * once the findings are recorded. Run from the liteparse root:
 *
 *   npx -y tsx apps/runner/scripts/probe-decode.ts
 *
 * Answers, with per-step token/logProb evidence:
 *   1. Does streaming-tiny-en (the dictation EN slot) loop on clean EN audio
 *      when run ONE-SHOT whole-clip (decode.ts policy)?
 *   2. Where does batch-tiny-ar start looping — does EOS ever approach top-1?
 *   3. Do the official mitigations fix it: proportional token cap
 *      (13 tok/s — the AR model card's own anti-loop rule) + repeated-n-gram
 *      force-EOS?
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "..", "models", "moonshine");
const CORPUS = resolve(
  HERE,
  "..", "..", "..", "..",
  "studygram-app", "scripts", "stt-lab", "corpus",
);

// ── shared piece loaders (mirror src, kept standalone) ───────────────────────
const { wavToModelAudio } = await import("../../../src/engines/moonshine/shared/audio.js");
const { loadTokenizer } = await import("../../../src/engines/moonshine/shared/tokens.js");
const { greedyPick } = await import("../../../src/engines/moonshine/shared/confidence.js");

type Desc = {
  id: string; dir: string; eosId: number; bosId: number; maxTokens: number;
  batch?: { depth: number; heads: number; headDim: number };
  streaming?: boolean;
};

const DESCS: Record<string, Desc> = {
  streaming: { id: "streaming-tiny-en", dir: "streaming-tiny-en", bosId: 1, eosId: 2, maxTokens: 512, streaming: true },
  arTiny: { id: "batch-tiny-ar", dir: "batch-tiny-ar", bosId: 1, eosId: 2, maxTokens: 194, batch: { depth: 6, heads: 8, headDim: 36 } },
  enBase: { id: "batch-base-en", dir: "batch-base-en", bosId: 1, eosId: 2, maxTokens: 512, batch: { depth: 8, heads: 8, headDim: 52 } },
};

const KV_KINDS = ["decoder.key", "decoder.value", "encoder.key", "encoder.value"] as const;

async function loadBatch(dir: string, d: Desc) {
  const p = resolve(MODELS, dir);
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(p, "encoder_model_int8.onnx"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "decoder_model_merged_int8.onnx"), { executionProviders: ["cpu"] }),
  ]);
  const tokenizer = loadTokenizer(JSON.parse(readFileSync(join(p, "tokenizer.json"), "utf-8")));
  return { d, tokenizer, encoder, decoder };
}

async function loadStreaming(dir: string, d: Desc) {
  const p = resolve(MODELS, dir);
  const [frontend, encoder, adapter, crossKv, decoderKv] = await Promise.all([
    ort.InferenceSession.create(join(p, "frontend.ort"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "encoder.ort"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "adapter.ort"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "cross_kv.ort"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "decoder_kv.ort"), { executionProviders: ["cpu"] }),
  ]);
  const cfg = JSON.parse(readFileSync(join(p, "streaming_config.json"), "utf-8"));
  const tokenizer = loadTokenizer(JSON.parse(readFileSync(join(p, "tokenizer.json"), "utf-8")));
  return { d, tokenizer, cfg, frontend, encoder, adapter, crossKv, decoderKv };
}

const T = (type: string, data: unknown, dims: number[]) => new ort.Tensor(type, data as never, dims);

function logitStats(logits: ArrayLike<number>, eosId: number) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i]! > max) max = logits[i]!;
  let sum = 0;
  const exp = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) { exp[i] = Math.exp(logits[i]! - max); sum += exp[i]!; }
  // top-3
  const idx = Array.from({ length: 3 }, () => 0);
  for (let i = 1; i < logits.length; i++) {
    if (logits[i]! > logits[idx[0]]!) { idx[2] = idx[1]; idx[1] = idx[0]; idx[0] = i; }
    else if (logits[i]! > logits[idx[1]]!) { idx[2] = idx[1]; idx[1] = i; }
    else if (logits[i]! > logits[idx[2]]!) idx[2] = i;
  }
  return {
    top: idx.map((i) => ({ id: i, p: exp[i]! / sum })),
    eosRankLogP: Math.log(exp[eosId]! / sum),
  };
}

/** Repeated-n-gram guard: true when the last `n` ids repeat the previous `n` (n=8). */
const NG = 8;
function loopsNow(ids: number[]): boolean {
  if (ids.length < NG * 2) return false;
  const a = ids.slice(ids.length - NG * 2, ids.length - NG);
  const b = ids.slice(ids.length - NG);
  return a.every((v, i) => v === b[i]);
}

interface Variant { cap?: "fixed" | "proportional"; loopGuard?: boolean }

async function decodeBatchProbe(
  m: Awaited<ReturnType<typeof loadBatch>>,
  samples: Float32Array,
  variant: Variant,
  verbose: boolean,
) {
  const { d, tokenizer, encoder, decoder } = m;
  const enc = await encoder.run({ input_values: T("float32", samples, [1, samples.length]) });
  const hidden = enc.last_hidden_state;
  const g = d.batch!;

  const past: Record<string, unknown> = {};
  for (let l = 0; l < g.depth; l++)
    for (const kind of KV_KINDS)
      past[`past_key_values.${l}.${kind}`] = T("float32", new Float32Array(0), [1, g.heads, 0, g.headDim]);

  const seconds = samples.length / 16000;
  const maxTokens = variant.cap === "proportional"
    ? Math.max(8, Math.min(d.maxTokens, Math.ceil(seconds * 13)))
    : d.maxTokens;

  const ids: number[] = [];
  const logProbs: number[] = [];
  let stoppedBy = "maxTokens";
  for (let step = 0; step < maxTokens; step++) {
    const out = await decoder.run({
      input_ids: T("int64", BigInt64Array.of(BigInt(step === 0 ? d.bosId : ids[step - 1]!)), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: T("bool", new Uint8Array([step === 0 ? 0 : 1]), [1]),
      ...past,
    });
    const logits = (out.logits as { data: Float32Array }).data;
    const pick = greedyPick(logits);
    if (verbose && step < 40) {
      const st = logitStats(logits, d.eosId);
      console.log(
        `    s${String(step).padStart(2)} id=${String(pick.id).padStart(5)} ` +
        `p=${pick.logProb.toFixed(2)} eos_lp=${st.eosRankLogP.toFixed(2)} ` +
        `top=[${st.top.map((t) => `${t.id}:${t.p.toFixed(2)}`).join(" ")}] ` +
        `'${tokenizer.decodeIds([pick.id])}'`,
      );
    }
    if (pick.id === d.eosId) { stoppedBy = "eos"; break; }
    ids.push(pick.id);
    logProbs.push(pick.logProb);
    if (variant.loopGuard && loopsNow(ids)) { stoppedBy = "loopGuard"; break; }
    for (let l = 0; l < g.depth; l++)
      for (const kind of KV_KINDS) {
        if (kind.startsWith("encoder.")) continue;
        past[`past_key_values.${l}.${kind}`] = out[`present.${l}.${kind}`];
      }
  }
  return { ids, logProbs, tokenizer, stoppedBy, maxTokens };
}

async function decodeStreamingProbe(
  m: Awaited<ReturnType<typeof loadStreaming>>,
  samples: Float32Array,
  variant: Variant,
  verbose: boolean,
) {
  const { d, tokenizer, cfg, frontend, encoder, adapter, crossKv, decoderKv } = m;
  const st = cfg.frontend_state_shapes;
  const f = await frontend.run({
    audio_chunk: T("float32", samples, [1, samples.length]),
    sample_buffer: T("float32", new Float32Array(st.sample_buffer.reduce((a, b) => a * b, 1)), st.sample_buffer),
    sample_len: T("int64", new BigInt64Array(1), st.sample_len),
    conv1_buffer: T("float32", new Float32Array(st.conv1_buffer.reduce((a, b) => a * b, 1)), st.conv1_buffer),
    conv2_buffer: T("float32", new Float32Array(st.conv2_buffer.reduce((a, b) => a * b, 1)), st.conv2_buffer),
    frame_count: T("int64", new BigInt64Array(1), st.frame_count),
  });
  const enc = await encoder.run({ features: f.features });
  const mem = await adapter.run({ encoded: enc.encoded, pos_offset: T("int64", BigInt64Array.of(0n), [1]) });
  const cross = await crossKv.run({ memory: mem.memory });

  const kvDims = [cfg.depth, 1, cfg.nheads, 0, cfg.head_dim];
  let kSelf: unknown = T("float32", new Float32Array(0), kvDims);
  let vSelf: unknown = T("float32", new Float32Array(0), kvDims);
  let token: unknown = T("int64", BigInt64Array.of(BigInt(d.bosId)), [1, 1]);

  const seconds = samples.length / 16000;
  const maxTokens = variant.cap === "proportional"
    ? Math.max(8, Math.min(d.maxTokens, Math.ceil(seconds * 13)))
    : d.maxTokens;

  const ids: number[] = [];
  const logProbs: number[] = [];
  let stoppedBy = "maxTokens";
  for (let step = 0; step < maxTokens; step++) {
    const out = await decoderKv.run({ token, k_self: kSelf, v_self: vSelf, out_k_cross: cross.k_cross, out_v_cross: cross.v_cross });
    const logits = (out.logits as { data: Float32Array }).data;
    const pick = greedyPick(logits);
    if (verbose && step < 40) {
      const stt = logitStats(logits, d.eosId);
      console.log(
        `    s${String(step).padStart(2)} id=${String(pick.id).padStart(5)} ` +
        `p=${pick.logProb.toFixed(2)} eos_lp=${stt.eosRankLogP.toFixed(2)} ` +
        `top=[${stt.top.map((t) => `${t.id}:${t.p.toFixed(2)}`).join(" ")}] ` +
        `'${tokenizer.decodeIds([pick.id])}'`,
      );
    }
    if (pick.id === d.eosId) { stoppedBy = "eos"; break; }
    ids.push(pick.id);
    logProbs.push(pick.logProb);
    if (variant.loopGuard && loopsNow(ids)) { stoppedBy = "loopGuard"; break; }
    token = T("int64", BigInt64Array.of(BigInt(pick.id)), [1, 1]);
    kSelf = out.out_k_self;
    vSelf = out.out_v_self;
  }
  return { ids, logProbs, tokenizer, stoppedBy, maxTokens };
}

function summarize(label: string, r: { ids: number[]; logProbs: number[]; tokenizer: { decodeIds: (ids: number[]) => string }; stoppedBy: string; maxTokens: number }) {
  const text = r.tokenizer.decodeIds(r.ids);
  console.log(`  → ${label}: ${r.ids.length}/${r.maxTokens} tokens (stopped: ${r.stoppedBy}), ${text.length} chars`);
  console.log(`     text: ${text.slice(0, 220) || "(empty)"}`);
  if (r.logProbs.length) {
    const mean = r.logProbs.reduce((a, b) => a + b, 0) / r.logProbs.length;
    console.log(`     mean logProb: ${mean.toFixed(3)}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
const clips = [
  { file: "tts-en.wav", label: "EN TTS (David)" },
  { file: "tts-ar.wav", label: "AR TTS (Hoda)" },
].filter((c) => existsSync(join(CORPUS, c.file)));

for (const clip of clips) {
  const bytes = new Uint8Array(readFileSync(join(CORPUS, clip.file)));
  const audio = wavToModelAudio(bytes, { maxSeconds: 60 });
  const secs = (audio.samples.length / 16000).toFixed(2);
  console.log(`\n════ ${clip.label} — ${secs}s ════`);

  if (clip.file.startsWith("tts-en")) {
    const m = await loadStreaming(DESCS.streaming.dir, DESCS.streaming);
    console.log("  [streaming-tiny-en · ONE-SHOT · fixed cap 512]");
    summarize("as-shipped", await decodeStreamingProbe(m, audio.samples, {}, true));
    console.log("  [streaming-tiny-en · proportional cap 13tok/s + loop guard]");
    summarize("fixed", await decodeStreamingProbe(m, audio.samples, { cap: "proportional", loopGuard: true }, false));
    void m;
  }
  if (clip.file.startsWith("tts-ar")) {
    const m = await loadBatch(DESCS.arTiny.dir, DESCS.arTiny);
    console.log(`  encoder inputs: ${m.encoder.inputNames.join(", ")} · decoder inputs: ${m.decoder.inputNames.slice(0, 5).join(", ")}…`);
    console.log("  [batch-tiny-ar · as-shipped (fixed cap 194, no guard)]");
    summarize("as-shipped", await decodeBatchProbe(m, audio.samples, {}, true));
    console.log("  [batch-tiny-ar · proportional cap 13tok/s + loop guard]");
    summarize("fixed", await decodeBatchProbe(m, audio.samples, { cap: "proportional", loopGuard: true }, false));
  }

  // EN batch-base comparison on the same clip (the voice-note slot-2 model)
  if (clip.file.startsWith("tts-en") && existsSync(join(MODELS, DESCS.enBase.dir))) {
    const m = await loadBatch(DESCS.enBase.dir, DESCS.enBase);
    console.log("  [batch-base-en · as-shipped]");
    summarize("as-shipped", await decodeBatchProbe(m, audio.samples, {}, false));
  }
}
console.log("\nprobe done");
