/**
 * Greedy decode loops for both Moonshine artifact families — runtime-agnostic.
 *
 * The Node engine (stt/moonshine-server, onnxruntime-node) and the browser
 * engine (engines/moonshine/moonshine-browser, onnxruntime-web/wasm) execute
 * the IDENTICAL loop through this module: one source of decode knowledge, so a
 * graph quirk fixed here is fixed everywhere (notably the batch export's
 * prefill-only cross-KV threading and the anti-loop decode budget — both loops).
 *
 * Host-specific concerns stay OUT: sessions are opaque {@link DecodeSession}s
 * (both ort runtimes structurally satisfy this), tensors are constructed by an
 * injected {@link TensorFactory} bound to the host ort module, and model bytes
 * are loaded by each engine (fs reads on Node, resolveModel/IndexedDB in the
 * browser).
 */
import { greedyPick } from "./confidence.js";
import { MODEL_SAMPLE_RATE } from "./audio.js";
import type { MoonshineModelDescriptor, StreamingConfig } from "./models.js";

/** What an InferenceSession means to the decode loops: feed map in, output map out. */
export interface DecodeSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * AR official streaming quirk: `frontend.model.ort` is a bare graph whose three
 * weight tensors (melspec projection + both conv kernels) are INPUTS, paired
 * with `frontend.weights.ort` — a blob graph run ONCE whose outputs are those
 * tensors by name (probed 2026-09-02; EN's frontend is monolithic). Run the
 * weights session once here and merge its outputs into every frontend call,
 * so {@link decodeStreaming} stays family-agnostic.
 */
export async function bindFrontendWeights(
  frontend: DecodeSession,
  weights: DecodeSession,
): Promise<DecodeSession> {
  const w = await weights.run({});
  return {
    run: (feeds) => frontend.run({ ...feeds, ...w }),
  };
}

/**
 * Zero-length/zero-filled tensor constructor bound to the host ort module
 * (`(type, data, dims) => new ort.Tensor(type, data, dims)`).
 */
export type TensorFactory = (type: string, data: unknown, dims: number[]) => unknown;

/** Streaming family: the five stateful `.ort` graphs, one-shot whole-clip. */
export interface StreamingDecodeModel {
  kind: "streaming";
  desc: MoonshineModelDescriptor;
  /** Parsed streaming_config.json (geometry the loop allocates from). */
  cfg: StreamingConfig;
  tensor: TensorFactory;
  frontend: DecodeSession;
  /**
   * RAW frontend sessions for release bookkeeping. Present only when
   * {@link bindFrontendWeights} wrapped the graph (AR official artifacts) —
   * the wrapper hides the real session inside `frontend`. Engines release
   * `frontendSessions ?? [frontend]`.
   */
  frontendSessions?: DecodeSession[];
  encoder: DecodeSession;
  adapter: DecodeSession;
  crossKv: DecodeSession;
  decoderKv: DecodeSession;
}

/** Batch family: the transformers.js-style int8 encoder + merged decoder pair. */
export interface BatchDecodeModel {
  kind: "batch";
  desc: MoonshineModelDescriptor;
  tensor: TensorFactory;
  encoder: DecodeSession;
  decoder: DecodeSession;
}

export type DecodeModel = StreamingDecodeModel | BatchDecodeModel;

export interface DecodeOutcome {
  ids: number[];
  logProbs: number[];
}

/** Read the decoder's logits row (`.data` — sync getter; WASM output is CPU-resident). */
function logitsOf(out: Record<string, unknown>): ArrayLike<number> {
  const data = (out.logits as { data?: ArrayLike<number> } | undefined)?.data;
  if (!data) {
    throw new Error("decoder returned no `logits` (or logits carries no .data) — artifact/export mismatch");
  }
  return data;
}

export async function decodeStreaming(
  m: StreamingDecodeModel,
  samples: Float32Array,
  signal?: AbortSignal,
): Promise<DecodeOutcome> {
  const ids: number[] = [];
  const logProbs: number[] = [];
  // The frontend needs at least one 80-sample frame to emit features.
  if (samples.length < 80) return { ids, logProbs };

  const t = m.tensor;
  const st = m.cfg.frontend_state_shapes;
  const f = await m.frontend.run({
    audio_chunk: t("float32", samples, [1, samples.length]),
    sample_buffer: t("float32", new Float32Array(prod(st.sample_buffer)), st.sample_buffer),
    sample_len: t("int64", new BigInt64Array(1), st.sample_len),
    conv1_buffer: t("float32", new Float32Array(prod(st.conv1_buffer)), st.conv1_buffer),
    conv2_buffer: t("float32", new Float32Array(prod(st.conv2_buffer)), st.conv2_buffer),
    frame_count: t("int64", new BigInt64Array(1), st.frame_count),
  });
  const enc = await m.encoder.run({ features: f.features });
  // One-shot whole clip → position offset 0 (chunk threading is the Phase D story).
  const mem = await m.adapter.run({
    encoded: enc.encoded,
    pos_offset: t("int64", BigInt64Array.of(0n), [1]),
  });
  const cross = await m.crossKv.run({ memory: mem.memory });

  // Empty self-KV [depth,1,heads,0,headDim] grows by one token per step (probed).
  const kvDims = [m.cfg.depth, 1, m.cfg.nheads, 0, m.cfg.head_dim];
  let kSelf: unknown = t("float32", new Float32Array(0), kvDims);
  let vSelf: unknown = t("float32", new Float32Array(0), kvDims);
  let token: unknown = t("int64", BigInt64Array.of(BigInt(m.desc.bosId)), [1, 1]);

  const maxTokens = tokenBudget(m.desc, samples.length / MODEL_SAMPLE_RATE);

  for (let step = 0; step < maxTokens; step++) {
    if (signal?.aborted) throw new Error("aborted");
    const out = await m.decoderKv.run({
      token,
      k_self: kSelf,
      v_self: vSelf,
      out_k_cross: cross.k_cross,
      out_v_cross: cross.v_cross,
    });
    const pick = greedyPick(logitsOf(out));
    if (pick.id === m.desc.eosId) break;
    ids.push(pick.id);
    logProbs.push(pick.logProb);
    token = t("int64", BigInt64Array.of(BigInt(pick.id)), [1, 1]);
    kSelf = out.out_k_self;
    vSelf = out.out_v_self;
  }
  return { ids, logProbs };
}

/** Batch merged-decoder KV kinds × layers, e.g. past_key_values.0.decoder.key. */
const BATCH_KV_KINDS = ["decoder.key", "decoder.value", "encoder.key", "encoder.value"] as const;

/**
 * Anti-hallucination-loop decode budget, per the model authors' own runtime
 * policy: cap generated tokens proportionally to audio length instead of a
 * flat ceiling. Batch family: 13 tok/s (the moonshine-tiny-ar model card's
 * stated anti-loop mitigation); streaming family: 6.5 tok/s (the official
 * moonshine-v2 C++ runtime's decode_full policy). The descriptor's maxTokens
 * (position-embedding limit) stays the hard ceiling; a small floor keeps a
 * sub-second blip able to emit a word.
 */
function tokenBudget(desc: MoonshineModelDescriptor, seconds: number): number {
  const rate = desc.variant === "streaming" ? 6.5 : 13;
  return Math.max(8, Math.min(desc.maxTokens, Math.ceil(seconds * rate)));
}

/**
 * Force-stop signal for a degenerate autoregressive loop: the last NG tokens
 * exactly repeat the NG before them. A real transcript repeating an 8-token
 * span verbatim is not a thing ASR output does; a hallucinating LM prior does
 * it constantly. Complements the length cap — the model card's AR models are
 * documented loopers even on clean input.
 */
const LOOP_NGRAM = 8;
function inLoop(ids: readonly number[]): boolean {
  if (ids.length < LOOP_NGRAM * 2) return false;
  const head = ids.slice(ids.length - LOOP_NGRAM * 2, ids.length - LOOP_NGRAM);
  const tail = ids.slice(ids.length - LOOP_NGRAM);
  return head.every((v, i) => v === tail[i]);
}

export async function decodeBatch(
  m: BatchDecodeModel,
  samples: Float32Array,
  signal?: AbortSignal,
): Promise<DecodeOutcome> {
  const ids: number[] = [];
  const logProbs: number[] = [];
  if (samples.length < 80) return { ids, logProbs };

  const t = m.tensor;
  const enc = await m.encoder.run({
    input_values: t("float32", samples, [1, samples.length]),
  });
  const hidden = enc.last_hidden_state;
  const g = m.desc.batch!;

  // Empty past [1,heads,0,headDim] (transformers.js layout, probed); the merged
  // graph's use_cache_branch=0 step consumes them and returns present.*.
  const past: Record<string, unknown> = {};
  for (let l = 0; l < g.depth; l++) {
    for (const kind of BATCH_KV_KINDS) {
      past[`past_key_values.${l}.${kind}`] = t("float32", new Float32Array(0), [
        1,
        g.heads,
        0,
        g.headDim,
      ]);
    }
  }

  const maxTokens = tokenBudget(m.desc, samples.length / MODEL_SAMPLE_RATE);

  for (let step = 0; step < maxTokens; step++) {
    if (signal?.aborted) throw new Error("aborted");
    const out = await m.decoder.run({
      input_ids: t("int64", BigInt64Array.of(BigInt(step === 0 ? m.desc.bosId : ids[step - 1]!)), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: t("bool", new Uint8Array([step === 0 ? 0 : 1]), [1]),
      ...past,
    });
    const pick = greedyPick(logitsOf(out));
    if (pick.id === m.desc.eosId) break;
    ids.push(pick.id);
    logProbs.push(pick.logProb);
    for (let l = 0; l < g.depth; l++) {
      for (const kind of BATCH_KV_KINDS) {
        // The prefill step (use_cache_branch=0) emits the REAL cross-attention
        // KV computed from encoder_hidden_states (present.*.encoder.* =
        // [1,heads,encFrames,headDim]) — thread it ONCE, then FREEZE: the
        // cache branch consumes the threaded encoder past and emits only an
        // empty placeholder ([0,heads,1,headDim], dim-0 zeroed — probed
        // 2026-09-01; it never recomputes cross-KV). Skipping this threading
        // leaves cross-attention with empty K/V at every step ≥ 1 — the
        // decoder goes DEAF and babbles LM-prior text to the token cap
        // (tiny-ar hallucination loops, base-en truncated summaries).
        if (step > 0 && kind.startsWith("encoder.")) continue;
        past[`past_key_values.${l}.${kind}`] = out[`present.${l}.${kind}`];
      }
    }
    if (inLoop(ids)) break; // degenerate repetition — cut before the cap fills
  }
  return { ids, logProbs };
}

function prod(dims: number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}
