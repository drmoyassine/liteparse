import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SttEngine, SttTranscribeOptions, SttResult } from "../types.js";
import { MODEL_SAMPLE_RATE, wavToModelAudio } from "../engines/moonshine/shared/audio.js";
import { parseWavPcm16, WavError } from "../engines/moonshine/shared/wav.js";

// Re-exported so the runner's stt-service can pre-flight the WAV contract and
// instanceof-check the failure. This subpath bundles its own copy of shared/wav
// (tsup entry chunks don't share modules), so importing the class from the
// "liteparse" index instead would yield a DIFFERENT class object and the check
// would silently always fail — the class must come from the same chunk.
export { parseWavPcm16, WavError };
import { loadTokenizer, stripTashkeel, type Tokenizer } from "../engines/moonshine/shared/tokens.js";
import { greedyPick, tokenConfidence } from "../engines/moonshine/shared/confidence.js";
import {
  DEFAULT_STT_MODEL,
  MOONSHINE_MODELS,
  type MoonshineModelDescriptor,
  type MoonshineModelId,
  type SttLanguage,
  type StreamingConfig,
} from "../engines/moonshine/shared/models.js";

/**
 * Node STT engine running the Moonshine cascade's local slots via
 * onnxruntime-node — the speech half of browser-runtime parity for the
 * self-hosted parse runner. Everything runtime-agnostic (WAV contract, mono/
 * resample, tokenizer, confidence math, model descriptors) lives in
 * ../engines/moonshine/shared/ and is imported, not duplicated, so the Phase C
 * browser WASM engine executes the identical pipeline.
 *
 * Two artifact families (spike-verified 2026-09-01, geometry in shared/models.ts):
 *
 *   streaming (EN slot 1) — five stateful `.ort` graphs, one-shot whole-clip:
 *     frontend(audio_chunk + state) → features[1,T/320,320]
 *     → encoder(features) → encoded
 *     → adapter(encoded, pos_offset) → memory
 *     → cross_kv(memory) → k/v_cross [depth,1,heads,T,headDim]  (layer-major)
 *     → decoder_kv(token[1,1], k/v_self [depth,1,heads,t,headDim]) → logits[1,1,32768]
 *
 *   batch (AR slot 1, EN slot 2) — transformers.js-style int8 pair:
 *     encoder(input_values = RAW waveform) → last_hidden_state[1,T,hidden]
 *     → decoder_merged(input_ids[1,1], past_key_values.* [1,heads,t,headDim],
 *                      use_cache_branch) → logits[1,1,32768] + present.*
 *
 * Both decoders expose logits, so confidence is the greedy pick's per-token
 * probability (shared/confidence.ts). The engine reports HONEST confidence and
 * never gates internally — the runner stt-service applies the floor and
 * escalates (mirrors how the cascade, not the engine, decides).
 *
 * Requires optional `onnxruntime-node`, loaded via dynamic import inside the
 * factory so importing this subpath never crashes a runtime that lacks it.
 *
 * Model layout (MOONSHINE_MODEL_PATH, default ./models/moonshine):
 *   streaming-tiny-en/{frontend,encoder,adapter,cross_kv,decoder_kv}.ort
 *     + tokenizer.json + streaming_config.json
 *   batch-tiny-ar/{encoder_model_int8,decoder_model_merged_int8}.onnx + tokenizer.json
 *   batch-base-en/{encoder_model_int8,decoder_model_merged_int8}.onnx + tokenizer.json
 */

let DEBUG = true;
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Optional native — typed as `any` (same pattern as ocr/rapidocr-server.ts).
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type OrtModule = any;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type OrtSession = any;

interface StreamingModel {
  kind: "streaming";
  desc: MoonshineModelDescriptor;
  tokenizer: Tokenizer;
  cfg: StreamingConfig;
  /** The ort module the sessions came from (Tensor class for the decode loop). */
  ort: OrtModule;
  frontend: OrtSession;
  encoder: OrtSession;
  adapter: OrtSession;
  crossKv: OrtSession;
  decoderKv: OrtSession;
}

interface BatchModel {
  kind: "batch";
  desc: MoonshineModelDescriptor;
  tokenizer: Tokenizer;
  ort: OrtModule;
  encoder: OrtSession;
  decoder: OrtSession;
}

type LoadedModel = StreamingModel | BatchModel;

interface MoonshineServer {
  ort: OrtModule;
  root: string;
  models: Map<string, LoadedModel>;
  loading: Map<string, Promise<LoadedModel>>;
}

let singleton: MoonshineServer | null = null;
let singletonPromise: Promise<MoonshineServer> | null = null;

export interface MoonshineServerOptions {
  /** Explicit Moonshine models directory (overrides auto-detection). */
  modelPath?: string;
  /** Force one model for every call (default: slot-1 model per language). */
  model?: MoonshineModelId | (string & {});
  /** Default language when transcribe() carries none (default "en"). */
  language?: SttLanguage;
  /** Emit STT telemetry (default true). */
  debug?: boolean;
  /** Keep Arabic diacritics (default: strip tashkeel — shared/tokens.ts policy). */
  keepDiacritics?: boolean;
  /** Clamp clip length before decode (default 60 s — runner budget). */
  maxSeconds?: number;
}

/** A Moonshine server engine with `dispose()` (release sessions) and `warm()` (preload). */
export type MoonshineServerEngine = SttEngine & {
  dispose(): void;
  warm(language?: SttLanguage): Promise<void>;
};

/**
 * Create the engine. The first call loads onnxruntime-node and resolves the
 * models root (cheap); per-model sessions load lazily on first use of that
 * language — `warm("en")` at process start avoids first-request latency.
 */
export async function createMoonshineServerEngine(
  opts: MoonshineServerOptions = {},
): Promise<MoonshineServerEngine> {
  DEBUG = opts.debug ?? true;
  if (!singleton) {
    if (!singletonPromise) {
      singletonPromise = loadServer(opts.modelPath);
    }
    try {
      singleton = await singletonPromise;
    } catch (err) {
      singletonPromise = null;
      throw err;
    }
  }
  return createEngine(singleton, opts);
}

function createEngine(server: MoonshineServer, opts: MoonshineServerOptions): MoonshineServerEngine {
  return {
    name: "moonshine-server",
    available: true,

    async transcribe(bytes: Uint8Array, topts: SttTranscribeOptions = {}): Promise<SttResult> {
      if (topts.signal?.aborted) throw new Error("aborted");
      const t0 = performance.now();

      const language: SttLanguage = topts.language ?? opts.language ?? "en";
      const modelId = resolveModelId(opts.model, language);
      const model = await ensureModel(server, modelId);

      // WAV PCM16 contract violations are a typed throw: the runner maps them
      // to 422 ("decode client-side"), and parseDocument's route falls through
      // with a warning. Everything else about the audio is our problem.
      const audio = wavToModelAudio(bytes, { maxSeconds: opts.maxSeconds ?? 60 });

      const { ids, logProbs } =
        model.kind === "streaming"
          ? await decodeStreaming(model, audio.samples, topts.signal)
          : await decodeBatch(model, audio.samples, topts.signal);

      const raw = model.tokenizer.decodeIds(ids);
      const text = opts.keepDiacritics ? raw : stripTashkeel(raw);
      const confidence = tokenConfidence(logProbs, model.tokenizer, ids);

      dbg(
        `[moonshine-server] ${modelId} ${((performance.now() - t0) / 1000).toFixed(2)}s: ` +
          `${(audio.samples.length / MODEL_SAMPLE_RATE).toFixed(1)}s audio (${audio.source.sampleRate}Hz ` +
          `${audio.source.channels}ch) → ${ids.length} tokens, ${text.length} chars, conf ${confidence.toFixed(3)}.`,
      );
      return { text, confidence, language };
    },

    async warm(language: SttLanguage = "en"): Promise<void> {
      await ensureModel(server, resolveModelId(opts.model, language));
    },

    dispose() {
      for (const model of server.models.values()) releaseModel(model);
      server.models.clear();
      server.loading.clear();
      if (singleton === server) {
        singleton = null;
        singletonPromise = null;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decode loops (greedy; per-step logits → logprob → confidence)
// ─────────────────────────────────────────────────────────────────────────────

interface DecodeOutcome {
  ids: number[];
  logProbs: number[];
}

async function decodeStreaming(
  m: StreamingModel,
  samples: Float32Array,
  signal?: AbortSignal,
): Promise<DecodeOutcome> {
  const ids: number[] = [];
  const logProbs: number[] = [];
  // The frontend needs at least one 80-sample frame to emit features.
  if (samples.length < 80) return { ids, logProbs };

  const t = tensorFactory(m);
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
  let kSelf = t("float32", new Float32Array(0), kvDims);
  let vSelf = t("float32", new Float32Array(0), kvDims);
  let token = t("int64", BigInt64Array.of(BigInt(m.desc.bosId)), [1, 1]);

  for (let step = 0; step < m.desc.maxTokens; step++) {
    if (signal?.aborted) throw new Error("aborted");
    const out = await m.decoderKv.run({
      token,
      k_self: kSelf,
      v_self: vSelf,
      out_k_cross: cross.k_cross,
      out_v_cross: cross.v_cross,
    });
    const pick = greedyPick(out.logits.data);
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

async function decodeBatch(
  m: BatchModel,
  samples: Float32Array,
  signal?: AbortSignal,
): Promise<DecodeOutcome> {
  const ids: number[] = [];
  const logProbs: number[] = [];
  if (samples.length < 80) return { ids, logProbs };

  const t = tensorFactory(m);
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

  for (let step = 0; step < m.desc.maxTokens; step++) {
    if (signal?.aborted) throw new Error("aborted");
    const out = await m.decoder.run({
      input_ids: t("int64", BigInt64Array.of(BigInt(step === 0 ? m.desc.bosId : ids[step - 1]!)), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: t("bool", new Uint8Array([step === 0 ? 0 : 1]), [1]),
      ...past,
    });
    const pick = greedyPick(out.logits.data);
    if (pick.id === m.desc.eosId) break;
    ids.push(pick.id);
    logProbs.push(pick.logProb);
    for (let l = 0; l < g.depth; l++) {
      for (const kind of BATCH_KV_KINDS) {
        // The merged export's cache branch (use_cache_branch=1) emits BROKEN
        // encoder-KV presents — [0,8,1,36] with dim 0 zeroed (probed 2026-09-01
        // against moonshine-tiny-ar-ONNX; feeding one back fails encoder_attn's
        // MatMul at step 3). That branch recomputes cross-KV from
        // encoder_hidden_states each step, so the encoder past stays EMPTY —
        // thread ONLY the decoder self-KV, never the encoder presents.
        if (kind.startsWith("encoder.")) continue;
        past[`past_key_values.${l}.${kind}`] = out[`present.${l}.${kind}`];
      }
    }
  }
  return { ids, logProbs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Model loading
// ─────────────────────────────────────────────────────────────────────────────

function resolveModelId(forced: MoonshineServerOptions["model"], language: SttLanguage): string {
  if (forced && MOONSHINE_MODELS[forced]) return forced;
  return DEFAULT_STT_MODEL[language];
}

async function ensureModel(server: MoonshineServer, id: string): Promise<LoadedModel> {
  const cached = server.models.get(id);
  if (cached) return cached;
  let loading = server.loading.get(id);
  if (!loading) {
    loading = loadModel(server, MOONSHINE_MODELS[id]!);
    server.loading.set(id, loading);
  }
  try {
    const model = await loading;
    server.models.set(id, model);
    return model;
  } catch (err) {
    server.loading.delete(id);
    throw err;
  }
}

async function loadModel(server: MoonshineServer, desc: MoonshineModelDescriptor): Promise<LoadedModel> {
  const tInit = performance.now();
  const dir = resolve(server.root, desc.dir);
  const paths: Record<string, string> = {};
  const missing: string[] = [];
  for (const [role, f] of Object.entries(desc.files)) {
    const p = resolve(dir, f.file);
    if (!existsSync(p)) missing.push(f.file);
    paths[role] = p;
  }
  if (missing.length) {
    throw new Error(
      `Moonshine model ${desc.id} incomplete under ${dir} — missing: ${missing.join(", ")}. ` +
        `Run apps/runner/scripts/fetch-moonshine-models.mjs or set MOONSHINE_MODEL_PATH.`,
    );
  }

  const tokenizer = loadTokenizer(JSON.parse(readFileSync(paths.tokenizer!, "utf-8")));
  const create = (p: string) => server.ort.InferenceSession.create(p, { executionProviders: ["cpu"] });

  if (desc.variant === "streaming") {
    const cfg = JSON.parse(readFileSync(paths.streamingConfig!, "utf-8")) as StreamingConfig;
    if (!cfg.frontend_state_shapes || !cfg.depth || !cfg.nheads || !cfg.head_dim) {
      throw new Error(`streaming_config.json for ${desc.id} lacks the expected geometry fields`);
    }
    const [frontend, encoder, adapter, crossKv, decoderKv] = await Promise.all([
      create(paths.frontend!),
      create(paths.encoder!),
      create(paths.adapter!),
      create(paths.crossKv!),
      create(paths.decoderKv!),
    ]);
    const model: StreamingModel = { kind: "streaming", desc, tokenizer, cfg, ort: server.ort, frontend, encoder, adapter, crossKv, decoderKv };
    dbg(`[moonshine-server] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${dir})`);
    return model;
  }

  const [encoder, decoder] = await Promise.all([create(paths.encoder!), create(paths.decoder!)]);
  const model: BatchModel = { kind: "batch", desc, tokenizer, ort: server.ort, encoder, decoder };
  dbg(`[moonshine-server] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${dir})`);
  return model;
}

function releaseModel(model: LoadedModel): void {
  if (model.kind === "streaming") {
    void model.frontend?.release();
    void model.encoder?.release();
    void model.adapter?.release();
    void model.crossKv?.release();
    void model.decoderKv?.release();
  } else {
    void model.encoder?.release();
    void model.decoder?.release();
  }
}

async function loadServer(explicitPath?: string): Promise<MoonshineServer> {
  let ort: OrtModule;
  try {
    ort = await import("onnxruntime-node");
  } catch {
    throw new Error("moonshine-server requires onnxruntime-node. Install it: npm install onnxruntime-node");
  }
  const root = await detectModelPath(explicitPath);
  if (!root) {
    throw new Error(
      "Moonshine models not found. Set MOONSHINE_MODEL_PATH or place models under ./models/moonshine " +
        "(expected subdirs: streaming-tiny-en, batch-tiny-ar, batch-base-en — fetch via " +
        "apps/runner/scripts/fetch-moonshine-models.mjs)",
    );
  }
  return { ort, root, models: new Map(), loading: new Map() };
}

async function detectModelPath(explicitPath?: string): Promise<string | null> {
  if (explicitPath) {
    // Same loud-failure policy as the env var: a wrong explicit path is a bug.
    if (!existsSync(explicitPath)) {
      throw new Error(`moonshine modelPath is set but does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }
  const envPath = process.env.MOONSHINE_MODEL_PATH;
  if (envPath) {
    // Loud failure on a set-but-missing path: silently falling through to the
    // cwd probe masks a deployment misconfiguration (the Dockerfile sets this).
    if (!existsSync(envPath)) {
      throw new Error(`MOONSHINE_MODEL_PATH is set but does not exist: ${envPath}`);
    }
    return envPath;
  }
  const cwdPath = resolve(process.cwd(), "models", "moonshine");
  return existsSync(cwdPath) ? cwdPath : null;
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Zero-length/zero-filled tensor factory bound to the model's ort module. */
function tensorFactory(m: LoadedModel) {
  const OrtTensor = m.ort.Tensor;
  if (!OrtTensor) throw new Error("ort.Tensor unavailable");
  return (type: string, data: unknown, dims: number[]) => new OrtTensor(type, data, dims);
}

function prod(dims: number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}
