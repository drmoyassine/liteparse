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
import { tokenConfidence } from "../engines/moonshine/shared/confidence.js";
import {
  MOONSHINE_MODELS,
  resolveModelId,
  type MoonshineModelDescriptor,
  type MoonshineModelId,
  type SttLanguage,
  type StreamingConfig,
} from "../engines/moonshine/shared/models.js";
import {
  decodeBatch,
  decodeStreaming,
  type BatchDecodeModel,
  type StreamingDecodeModel,
  type TensorFactory,
} from "../engines/moonshine/shared/decode.js";

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

interface StreamingModel extends StreamingDecodeModel {
  tokenizer: Tokenizer;
}

interface BatchModel extends BatchDecodeModel {
  tokenizer: Tokenizer;
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
// Model loading (the decode loops themselves live in shared/decode.ts — one
// source for both runtimes, so a graph quirk like the batch export's broken
// cache-branch encoder-KV presents is fixed once, not ported)
// ─────────────────────────────────────────────────────────────────────────────


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
  const tensor = makeTensorFactory(server.ort);

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
    const model: StreamingModel = { kind: "streaming", desc, tokenizer, cfg, tensor, frontend, encoder, adapter, crossKv, decoderKv };
    dbg(`[moonshine-server] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${dir})`);
    return model;
  }

  const [encoder, decoder] = await Promise.all([create(paths.encoder!), create(paths.decoder!)]);
  const model: BatchModel = { kind: "batch", desc, tokenizer, tensor, encoder, decoder };
  dbg(`[moonshine-server] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${dir})`);
  return model;
}

function releaseModel(model: LoadedModel): void {
  // Sessions satisfy the runtime's release(); the decode contract types only
  // what the loops need (run), so reach the host method through a cast.
  const sessions: OrtSession[] =
    model.kind === "streaming"
      ? [model.frontend, model.encoder, model.adapter, model.crossKv, model.decoderKv]
      : [model.encoder, model.decoder];
  for (const s of sessions) void s?.release?.();
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

/** Zero-length/zero-filled tensor factory bound to the ort module (shared/decode contract). */
function makeTensorFactory(ort: OrtModule): TensorFactory {
  const OrtTensor = ort.Tensor;
  if (!OrtTensor) throw new Error("ort.Tensor unavailable");
  return (type: string, data: unknown, dims: number[]) => new OrtTensor(type, data, dims);
}
