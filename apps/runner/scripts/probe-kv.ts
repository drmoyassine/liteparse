/**
 * KV-threading probe — does the onnx-community merged decoder need the PREFILL
 * (step-0) encoder presents threaded for cross-attention? Prints present.*
 * shapes at step 0 vs step 1, then decodes AR + EN with the moonshine-js
 * official threading (all kinds at step 0, decoder kinds only afterwards).
 * Standalone diagnostic; run: npx -y tsx apps/runner/scripts/probe-kv.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "..", "models", "moonshine");
const CORPUS = resolve(HERE, "..", "..", "..", "..", "studygram-app", "scripts", "stt-lab", "corpus");
const { wavToModelAudio } = await import("../../../src/engines/moonshine/shared/audio.js");
const { loadTokenizer } = await import("../../../src/engines/moonshine/shared/tokens.js");

const T = (type: string, data: unknown, dims: number[]) => new ort.Tensor(type, data as never, dims);
const KV_KINDS = ["decoder.key", "decoder.value", "encoder.key", "encoder.value"] as const;

interface Case { dir: string; name: string; depth: number; heads: number; headDim: number; wav: string }

const cases: Case[] = [
  { dir: "batch-tiny-ar", name: "AR tiny", depth: 6, heads: 8, headDim: 36, wav: "tts-ar.wav" },
  { dir: "batch-base-en", name: "EN base", depth: 8, heads: 8, headDim: 52, wav: "tts-en.wav" },
];

for (const c of cases) {
  const p = resolve(MODELS, c.dir);
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(p, "encoder_model_int8.onnx"), { executionProviders: ["cpu"] }),
    ort.InferenceSession.create(join(p, "decoder_model_merged_int8.onnx"), { executionProviders: ["cpu"] }),
  ]);
  const tokenizer = loadTokenizer(JSON.parse(readFileSync(join(p, "tokenizer.json"), "utf-8")));
  const audio = wavToModelAudio(new Uint8Array(readFileSync(join(CORPUS, c.wav))), { maxSeconds: 60 });
  const hidden = (await encoder.run({ input_values: T("float32", audio.samples, [1, audio.samples.length]) })).last_hidden_state;

  const emptyPast = () => {
    const o: Record<string, unknown> = {};
    for (let l = 0; l < c.depth; l++)
      for (const k of KV_KINDS) o[`past_key_values.${l}.${k}`] = T("float32", new Float32Array(0), [1, c.heads, 0, c.headDim]);
    return o;
  };
  const step = (ids: number[], past: Record<string, unknown>, branch: 0 | 1) =>
    decoder.run({
      input_ids: T("int64", BigInt64Array.of(BigInt(ids.length ? ids[ids.length - 1]! : 1)), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: T("bool", new Uint8Array([branch]), [1]),
      ...past,
    });
  const shapeOf = (t: unknown) => JSON.stringify((t as { dims: number[] }).dims);

  console.log(`\n════ ${c.name} (${c.dir}) ════`);

  // 1. present shapes at step 0 (prefill) vs step 1 (cache branch)
  const past0 = emptyPast();
  const s0 = await step([], past0, 0);
  console.log("  step0 (prefill) presents:");
  for (const k of ["0.decoder.key", "0.encoder.key", `${c.depth - 1}.decoder.key`, `${c.depth - 1}.encoder.key`])
    console.log(`    present.${k} → ${shapeOf(s0[`present.${k}`])}`);
  const past1: Record<string, unknown> = {};
  for (let l = 0; l < c.depth; l++)
    for (const k of KV_KINDS) past1[`past_key_values.${l}.${k}`] = s0[`present.${l}.${k}`]; // thread ALL (official)
  const s1 = await step([1], past1, 1);
  console.log("  step1 (cache branch, all presents threaded from prefill):");
  for (const k of ["0.decoder.key", "0.encoder.key"]) console.log(`    present.${k} → ${shapeOf(s1[`present.${k}`])}`);

  // 2. decode with OFFICIAL threading (encoder kinds threaded once at prefill, then frozen)
  const past: Record<string, unknown> = emptyPast();
  const ids: number[] = [];
  let stopped = "cap";
  for (let stepI = 0; stepI < 194; stepI++) {
    const out = await step(stepI === 0 ? [] : ids, past, stepI === 0 ? 0 : 1);
    const logits = (out.logits as { data: Float32Array }).data;
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i]! > logits[best]!) best = i;
    if (best === 2) { stopped = "eos"; break; }
    ids.push(best);
    if (stepI === 0) {
      for (let l = 0; l < c.depth; l++) for (const k of KV_KINDS) past[`past_key_values.${l}.${k}`] = out[`present.${l}.${k}`];
    } else {
      for (let l = 0; l < c.depth; l++)
        for (const k of KV_KINDS) if (!k.startsWith("encoder.")) past[`past_key_values.${l}.${k}`] = out[`present.${l}.${k}`];
    }
  }
  console.log(`  official threading (${c.name}): ${ids.length} tokens, stopped: ${stopped}`);
  console.log(`  text: ${tokenizer.decodeIds(ids).slice(0, 200) || "(empty)"}`);
}
console.log("\nprobe-kv done");
