/**
 * Moonshine browser runner on onnxruntime-web — the STT counterpart of
 * engines/rapidocr/rapidocr-onnx-runner.ts, and the browser twin of
 * stt/moonshine-server.ts (which runs the same graphs on onnxruntime-node).
 *
 * Everything runtime-agnostic — WAV contract, mono/resample, tokenizer,
 * confidence, model descriptors, and the DECODE LOOPS — lives in ./shared/ and
 * is imported, not duplicated: a graph quirk (the batch export's prefill-only
 * cross-KV threading) is fixed once for both runtimes.
 *
 * Differences from the server engine, by design:
 *  - weights arrive via resolveModel (origin → IndexedDB read-through), not fs;
 *  - a non-WAV container is decoded IN-ENGINE via AudioContext.decodeAudioData
 *    (browsers read webm/opus/mp3/m4a natively — the server's 422 contract
 *    exists because Node can't, not because the cascade wants WAV only);
 *  - the confidence gate is applied HERE (createRapidOcrRunner-style), not by a
 *    caller-side service: `text non-empty && conf < floor` ⇒ `{text:""}` ⇒ the
 *    route's char-count floor under-yields ⇒ executeRoute descends to the
 *    stt-gateway leg. The server engine reports honest confidence and lets the
 *    runner service gate, because its escalation slots are local; the browser's
 *    only stronger leg is external.
 *  - a per-model LRU caps resident sessions (default 2: EN streaming + AR batch
 *    ≈ 139 MB of weights — beside the OCR pair that IS the memory pressure case).
 *    Forcing the AR streaming model instead of batch AR adds ~32 MB (and needs
 *    the files mirrored same-origin — see BROWSER_DEFAULT_STT_MODEL).
 */

// Load the WASM-ONLY (non-jsep) build LAZILY — same reasoning as the OCR runner:
// the default onnxruntime-web export loads the jsep/WebGPU wasm and computes
// NaN as pure CPU; the ./wasm subpath is the plain SIMD build. Dynamic, not
// static: onnxruntime-web is an optional peer and this module is re-exported
// from the liteparse index — a static import would crash module-link time for
// consumers that install without the peer. ort is loaded once on the first
// model init; nothing at module scope touches it.
type OrtWasm = typeof import("onnxruntime-web/wasm");
let ortPromise: Promise<OrtWasm> | undefined;
async function loadOrt(): Promise<OrtWasm> {
  ortPromise ??= import("onnxruntime-web/wasm").then((mod) => {
    // ALWAYS LOGGED (not dbg-gated): a load failure must stay visible in prod.
    const g = globalThis as typeof globalThis & {
      crossOriginIsolated?: boolean;
      navigator?: { hardwareConcurrency?: number };
    };
    console.log(
      "[moonshine-browser] ort module loaded; env.wasm present:",
      !!mod.env?.wasm,
      "| crossOriginIsolated:", g.crossOriginIsolated ?? false,
      "| numThreads target:", g.crossOriginIsolated ? Math.max(1, (g.navigator?.hardwareConcurrency ?? 2) - 1) : 1,
    );
    return mod;
  });
  return ortPromise;
}

import type { ModelOrigin } from "../../worker/model-origin.js";
import { resolveModel, createThrowModelOrigin } from "../../worker/model-origin.js";
// NOTE: this module MUST NOT import "../../worker/ocr-worker.js" — it carries
// the self-installing worker shell, and this engine ships under its own tsup
// entry (@drmoyassine/liteparse/engines/moonshine); importing the shell would bake a SECOND
// copy into that bundle and overwrite the worker's onmessage (the RapidOCR
// double-shell bug). The model origin is INJECTED, never read from worker config.
import type { SttEngine, SttResult, SttTranscribeOptions } from "../../types.js";
import { MODEL_SAMPLE_RATE, resample, wavToModelAudio, type ModelAudio } from "./shared/audio.js";
import { parseWavPcm16, WavError } from "./shared/wav.js";
import { loadTokenizer, stripTashkeel, type Tokenizer } from "./shared/tokens.js";
import { sttFloorFor, tokenConfidence } from "./shared/confidence.js";
import {
  BROWSER_DEFAULT_STT_MODEL,
  MOONSHINE_MODELS,
  resolveModelId,
  type MoonshineModelId,
  type SttLanguage,
  type StreamingConfig,
} from "./shared/models.js";
import {
  bindFrontendWeights,
  decodeBatch,
  decodeStreaming,
  type BatchDecodeModel,
  type DecodeModel,
  type StreamingDecodeModel,
  type TensorFactory,
} from "./shared/decode.js";
import { rms, sttDebugLine } from "./shared/stats.js";
import { moonshineDescriptor } from "./model-origin-hf.js";

// ── Telemetry gate (same policy as the OCR runner: diagnostics ON by default,
// `debug: false` for prod-quiet; real error paths stay on console.warn). ──────
let DEBUG = true;
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

export interface MoonshineBrowserOptions {
  /**
   * Model origin for weights + JSON sidecars (the fetch/cache seam). REQUIRED
   * for transcription to work — pass the SAME origin you give
   * `configureWorker({ modelOrigin })`; `createMoonshineModelOrigin()` is the
   * HF + same-origin-sidecars default. Injected (never read from worker
   * config) for the double-shell reason noted above.
   */
  modelOrigin?: ModelOrigin;
  /** Force one model for every call (default: slot-1 model per language). */
  model?: MoonshineModelId | (string & {});
  /** Default language when transcribe() carries none (default "en"). */
  language?: SttLanguage;
  /** Emit STT telemetry — the stt-lab line per transcribe (default true). */
  debug?: boolean;
  /** Keep Arabic diacritics (default: strip tashkeel — shared/tokens.ts policy). */
  keepDiacritics?: boolean;
  /** Clamp clip length before decode (default 60 s — bounded by maxTokens anyway). */
  maxSeconds?: number;
  /**
   * Cap on simultaneously resident models; least-recently-used is disposed
   * (default 2 — EN streaming + AR batch; set 1 for low-memory devices).
   */
  maxLoadedModels?: number;
}

interface LoadedBrowserModel {
  modelId: string;
  model: DecodeModel;
  tokenizer: Tokenizer;
}

/**
 * One Moonshine runner: lazily loads models per id (IndexedDB read-through),
 * LRU-evicts when over {@link MoonshineBrowserOptions.maxLoadedModels}, and
 * transcribes clips through the shared decode loops.
 */
export class MoonshineRunner {
  private ort: OrtWasm | null = null;
  private readonly models = new Map<string, LoadedBrowserModel>();
  private readonly loading = new Map<string, Promise<LoadedBrowserModel>>();
  /** Loaded model ids, least-recently-used first. */
  private readonly lru: string[] = [];
  private readonly modelOrigin: ModelOrigin | null;
  private readonly maxLoaded: number;

  constructor(private readonly opts: MoonshineBrowserOptions = {}) {
    this.modelOrigin = opts.modelOrigin ?? null;
    this.maxLoaded = Math.max(1, opts.maxLoadedModels ?? 2);
  }

  async transcribe(bytes: Uint8Array, topts: SttTranscribeOptions = {}): Promise<SttResult> {
    if (topts.signal?.aborted) throw new Error("aborted");
    const t0 = performance.now();

    const language: SttLanguage = topts.language ?? this.opts.language ?? "en";
    // Browser defaults (BROWSER map): AR stays batch — the official streaming
    // CDN sends no CORS headers, so a tab can't fetch those graphs from source.
    const modelId = resolveModelId(this.opts.model, language, BROWSER_DEFAULT_STT_MODEL);
    const loaded = await this.ensureModel(modelId);

    const audio = await this.audioIn(bytes);
    const decodeStart = performance.now();
    const { ids, logProbs } =
      loaded.model.kind === "streaming"
        ? await decodeStreaming(loaded.model, audio.samples, topts.signal)
        : await decodeBatch(loaded.model, audio.samples, topts.signal);
    const decodeSeconds = (performance.now() - decodeStart) / 1000;

    const raw = loaded.tokenizer.decodeIds(ids);
    const text = this.opts.keepDiacritics ? raw : stripTashkeel(raw);
    const confidence = tokenConfidence(logProbs, loaded.tokenizer, ids);

    // stt-lab line (one flat record per transcribe; debug-gated like OCR telemetry).
    dbg(
      sttDebugLine({
        modelId,
        language,
        decodeSeconds,
        audioSeconds: audio.samples.length / MODEL_SAMPLE_RATE,
        ids,
        logProbs,
        tokenizer: loaded.tokenizer,
        rms: rms(audio.samples),
        diacriticsStripped: !this.opts.keepDiacritics,
      }),
    );

    // ── Confidence gate (garbage indicator → external-gateway fallback) ──────
    // Applied HERE, unlike the server engine: the browser cascade's only
    // stronger leg is the external stt-gateway, and executeRoute descends to it
    // on under-yield — so discarding low-confidence text (returning "") IS the
    // escalation signal. Same shape as the RapidOcrRunner gate; the text-
    // non-empty guard keeps a genuine no-speech result out of the "discarded" log.
    if (text.trim().length > 0 && confidence < sttFloorFor(modelId)) {
      dbg(
        `[moonshine-browser] confidence gate TRIPPED: ${modelId} conf ${confidence.toFixed(3)} < ` +
          `floor ${sttFloorFor(modelId)} — discarding ${text.length} chars, escalating to the stt-gateway via under-yield.`,
      );
      return { text: "", confidence, language };
    }
    return { text, confidence, language };
  }

  /** Preload a language's slot-1 model (mic-intent / app-start warm-up). */
  async warm(language: SttLanguage = "en"): Promise<void> {
    await this.ensureModel(resolveModelId(this.opts.model, language, BROWSER_DEFAULT_STT_MODEL));
  }

  /** True once a model for `language` is resident (post-warm check). */
  hasModel(language: SttLanguage): boolean {
    return this.models.has(resolveModelId(this.opts.model, language, BROWSER_DEFAULT_STT_MODEL));
  }

  /** Release every resident model's sessions (keeps the IndexedDB cache). */
  dispose(): void {
    for (const loaded of this.models.values()) releaseModel(loaded.model);
    this.models.clear();
    this.loading.clear();
    this.lru.length = 0;
  }

  // ─── model lifecycle ───────────────────────────────────────────────────────

  private async ensureModel(modelId: string): Promise<LoadedBrowserModel> {
    const cached = this.models.get(modelId);
    if (cached) {
      this.touch(modelId);
      return cached;
    }
    let loading = this.loading.get(modelId);
    if (!loading) {
      loading = this.loadModel(modelId);
      this.loading.set(modelId, loading);
    }
    try {
      const loaded = await loading;
      // Clear the inflight entry on success too: a leaked RESOLVED promise
      // would resurrect an LRU-evicted (session-released) model instead of
      // re-fetching it — the released sessions then fail at first run.
      this.loading.delete(modelId);
      this.models.set(modelId, loaded);
      this.touch(modelId);
      // LRU cap AFTER insert: evict least-recently-used residents down to the
      // cap (never the model we just loaded — touch put it last).
      while (this.lru.length > this.maxLoaded) {
        const victim = this.lru.shift()!;
        const evicted = this.models.get(victim);
        this.models.delete(victim);
        if (evicted) {
          releaseModel(evicted.model);
          dbg(`[moonshine-browser] LRU evicted ${victim} (cap ${this.maxLoaded} — weights stay in IndexedDB).`);
        }
      }
      return loaded;
    } catch (err) {
      this.loading.delete(modelId);
      throw err;
    }
  }

  private touch(modelId: string): void {
    const at = this.lru.indexOf(modelId);
    if (at >= 0) this.lru.splice(at, 1);
    this.lru.push(modelId);
  }

  private async loadModel(modelId: string): Promise<LoadedBrowserModel> {
    const desc = MOONSHINE_MODELS[modelId];
    if (!desc) throw new Error(`unknown Moonshine model id: ${modelId} (see shared/models.ts)`);

    // ort first, env configured BEFORE the first InferenceSession.create (ort
    // reads numThreads/wasmPaths exactly once, at initializeWebAssembly).
    const ort = (this.ort ??= await this.loadOrtConfigured());
    const origin = this.modelOrigin ?? createThrowModelOrigin();

    const tInit = performance.now();
    const roles = Object.keys(desc.files);
    const byteList = await Promise.all(
      roles.map((role) => resolveModel(moonshineDescriptor(desc, role), origin)),
    );
    const bytes = new Map<string, Uint8Array>(roles.map((role, i) => [role, byteList[i]!]));
    const json = (role: string) => new TextDecoder().decode(bytes.get(role)!);

    const tokenizer = loadTokenizer(JSON.parse(json("tokenizer")));
    const create = (role: string) => ort.InferenceSession.create(bytes.get(role));
    const tensor: TensorFactory = (type, data, dims) => new ort.Tensor(type, data, dims);

    if (desc.variant === "streaming") {
      const cfg = JSON.parse(json("streamingConfig")) as StreamingConfig;
      if (!cfg.frontend_state_shapes || !cfg.depth || !cfg.nheads || !cfg.head_dim) {
        throw new Error(`streaming_config.json for ${desc.id} lacks the expected geometry fields`);
      }
      const [frontendSession, frontendWeights, encoder, adapter, crossKv, decoderKv] = await Promise.all([
        create("frontend"),
        // AR official set only (desc.files.frontendWeights): the weights blob.
        bytes.has("frontendWeights") ? create("frontendWeights") : undefined,
        create("encoder"),
        create("adapter"),
        create("crossKv"),
        create("decoderKv"),
      ]);
      // Weighted frontends (AR): run the blob once, merge into every frontend call.
      const frontend = frontendWeights
        ? await bindFrontendWeights(frontendSession, frontendWeights)
        : frontendSession;
      const model: StreamingDecodeModel = {
        kind: "streaming",
        desc,
        cfg,
        tensor,
        frontend,
        frontendSessions: frontendWeights ? [frontendSession, frontendWeights] : undefined,
        encoder,
        adapter,
        crossKv,
        decoderKv,
      };
      dbg(`[moonshine-browser] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${this.models.size + 1}/${this.maxLoaded} resident)`);
      return { modelId, model, tokenizer };
    }

    const [encoder, decoder] = await Promise.all([create("encoder"), create("decoder")]);
    const model: BatchDecodeModel = { kind: "batch", desc, tensor, encoder, decoder };
    dbg(`[moonshine-browser] loaded ${desc.id} (${((performance.now() - tInit) / 1000).toFixed(1)}s, ${this.models.size + 1}/${this.maxLoaded} resident)`);
    return { modelId, model, tokenizer };
  }

  private async loadOrtConfigured(): Promise<OrtWasm> {
    const ort = await loadOrt();
    // Full-origin URL (runtime value) so Vite leaves ort's dynamic import alone
    // — the browser then fetches the glue from our own /ort/ (self-hosted; the
    // rapidocr runner verified a path-relative value gets inlined into /public).
    // Files land there via scripts/copy-ort-wasm.mjs — the SAME copy OCR uses,
    // so an app with both engines shares one set of wasm assets.
    ort.env.wasm.wasmPaths = self.location.origin + "/" + "ort/";
    // >1 thread WITHOUT cross-origin isolation still loads the threaded WASM
    // but its kernels compute NaN (the "falling back" log does NOT swap the
    // file) — only opt into threads when actually isolated.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, navigator.hardwareConcurrency - 1)
      : 1;
    return ort;
  }

  // ─── audio in ──────────────────────────────────────────────────────────────

  /**
   * Container bytes → 16 kHz mono. WAV PCM16 parses in pure JS (shared/wav);
   * anything else decodes through AudioContext.decodeAudioData — the browser
   * CAN read webm/opus/mp3/m4a natively, which is exactly why the server's
   * WAV-only contract tells browsers to decode client-side. Both failures
   * (unparseable AND undecodable) throw: executeRoute records the warning and
   * the external gateway leg (which decodes any container server-side) runs.
   */
  private async audioIn(bytes: Uint8Array): Promise<ModelAudio> {
    const maxSeconds = this.opts.maxSeconds ?? 60;
    try {
      return wavToModelAudio(bytes, { maxSeconds });
    } catch (err) {
      if (!(err instanceof WavError)) throw err;
      return decodeContainerToModelAudio(bytes, maxSeconds, err);
    }
  }
}

/** Minimal AudioContext shape the fallback needs (avoids DOM lib coupling). */
interface DecodeAudioContext {
  decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer>;
  close(): Promise<void>;
}
interface AudioBufferLike {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

async function decodeContainerToModelAudio(
  bytes: Uint8Array,
  maxSeconds: number,
  wavErr: WavError,
): Promise<ModelAudio> {
  const g = globalThis as {
    AudioContext?: new () => DecodeAudioContext;
    webkitAudioContext?: new () => DecodeAudioContext;
  };
  const AC = g.AudioContext ?? g.webkitAudioContext;
  if (!AC) {
    throw new Error(
      `audio is not WAV PCM16 (${wavErr.code}: ${wavErr.message}) and this runtime has no ` +
        `AudioContext to decode the container — decode to WAV first (encodeWavPcm16)`,
    );
  }
  const ctx = new AC();
  try {
    // decodeAudioData DETACHES the buffer it receives; copy so the caller's
    // bytes survive (the gateway leg reuses them).
    const buffer: AudioBufferLike = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    let mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + ch[i]! / buffer.numberOfChannels;
    }
    if (maxSeconds && mono.length > maxSeconds * buffer.sampleRate) {
      mono = mono.subarray(0, Math.floor(maxSeconds * buffer.sampleRate));
    }
    const samples = resample(mono, buffer.sampleRate, MODEL_SAMPLE_RATE);
    return {
      samples,
      sampleRate: MODEL_SAMPLE_RATE,
      source: { sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels },
    };
  } catch (err) {
    throw new Error(
      `browser could not decode the audio container (${wavErr.code} at the WAV layer): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  } finally {
    void ctx.close();
  }
}

function releaseModel(model: DecodeModel): void {
  // Sessions satisfy the runtime's release(); the decode contract types only
  // what the loops need (run), so reach the host method through a cast.
  // frontendSessions ?? [frontend]: the AR wrapper is not a session, the raw
  // pair is listed instead (see StreamingDecodeModel.frontendSessions).
  const sessions = (model.kind === "streaming"
    ? [
        ...(model.frontendSessions ?? [model.frontend]),
        model.encoder,
        model.adapter,
        model.crossKv,
        model.decoderKv,
      ]
    : [model.encoder, model.decoder]) as unknown as { release?: () => Promise<void> }[];
  for (const s of sessions) void s?.release?.();
}

// ─── public factories ────────────────────────────────────────────────────────

export interface MoonshineRunnerHandle {
  transcribe(bytes: Uint8Array, opts?: SttTranscribeOptions): Promise<SttResult>;
  warm(language?: SttLanguage): Promise<void>;
  dispose(): void;
}

/**
 * Create a standalone per-language Moonshine runner (direct use — e.g. a
 * dictation worker in Phase D, or a transcript box that isn't parseDocument).
 * For the parse pipeline prefer {@link createMoonshineSttEngine} +
 * `setBrowserSttEngine`.
 */
export function createMoonshineRunner(opts: MoonshineBrowserOptions = {}): MoonshineRunnerHandle {
  DEBUG = opts.debug ?? true;
  return new MoonshineRunner(opts);
}

export interface MoonshineSttEngineOptions extends MoonshineBrowserOptions {
  /**
   * Languages this engine may load models for (default both — the cascade's
   * tier split). A request outside the set rejects loudly; the route records
   * the warning and the external gateway leg takes the clip.
   */
  languages?: SttLanguage[];
}

/**
 * Create the {@link SttEngine} the parse pipeline consumes — register it once
 * at app start:
 *
 * ```ts
 * setBrowserSttEngine(
 *   createMoonshineSttEngine({
 *     languages: ["en", "ar"],
 *     modelOrigin: createMoonshineModelOrigin(),
 *   }),
 * );
 * ```
 *
 * Dispatches to the slot-1 model per language (`BROWSER_DEFAULT_STT_MODEL`),
 * loads lazily on first use of that language, and LRU-disposes at
 * `maxLoadedModels` (default 2). Applies the confidence floor internally
 * (under-yield ⇒ the route's external stt-gateway leg runs).
 */
export function createMoonshineSttEngine(
  opts: MoonshineSttEngineOptions = {},
): SttEngine & { warm(language?: SttLanguage): Promise<void>; dispose(): void } {
  DEBUG = opts.debug ?? true;
  const languages = opts.languages ?? ["en", "ar"];
  const runner = new MoonshineRunner(opts);
  return {
    name: "moonshine",
    available: true,
    async transcribe(bytes: Uint8Array, topts: SttTranscribeOptions = {}): Promise<SttResult> {
      const language: SttLanguage = topts.language ?? opts.language ?? "en";
      if (!languages.includes(language)) {
        throw new Error(
          `moonshine: language "${language}" is not enabled (languages: ${languages.join(", ")}) — ` +
            `the clip falls through to the external gateway`,
        );
      }
      return runner.transcribe(bytes, topts);
    },
    warm: (language: SttLanguage = "en") => runner.warm(language),
    dispose: () => runner.dispose(),
  };
}
