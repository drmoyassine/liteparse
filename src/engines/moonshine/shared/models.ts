/**
 * Moonshine model descriptors — the single source of truth for the artifact
 * set: browser origin URLs (Phase C), the runner fetch script and Dockerfile
 * pins (B.3), and the runtime geometry each decode loop allocates from.
 *
 * Ground truth verified 2026-09-01 (HF API + apps/runner/scripts/spike-moonshine.mjs
 * + decoder probes; findings in ROADMAP Track 3 "Artifact status"):
 *
 *   EN  streaming tiny — moonshine-ai/moonshine-streaming onnx/tiny/*.ort (MIT).
 *       Five stateful graphs; KV layout is LAYER-MAJOR [depth,1,heads,T,headDim];
 *       geometry from on-disk streaming_config.json, mirrored here for typing.
 *   AR  streaming tiny — OFFICIAL Useful Sensors artifacts (quantized_26_08_24,
 *       verified 2026-09-02: clean one-shot AND chunked decode past 2 s where
 *       the HF checkpoint weights loop), served from a byte-identical HF MIRROR
 *       (Drmoyassine/moonshine-streaming-tiny-ar-ort) because the official CDN
 *       sends no CORS headers and thus cannot serve browsers. MIT — the
 *       streaming family is MIT per the upstream LICENSE (verified 2026-09-03;
 *       an earlier note here wrongly said Community License). Same five-graph
 *       layout as EN plus one quirk: the frontend ships as graph + weights
 *       pair (see frontendWeights below).
 *   EN  batch base int8 — onnx-community/moonshine-base-ONNX (MIT). Encoder
 *       input is RAW waveform (`input_values`); past-KV layout is transformers.js
 *       [1,heads,T,headDim] (config: 8 layers × 8 heads × 52, positions ≤ 512).
 *       (An AR batch sibling, moonshine-batch-tiny-ar, was removed 2026-09-03:
 *       license "other", superseded by the streaming set on every tier.)
 */

export type SttLanguage = "en" | "ar";

/** File roles per family; values are repo-relative path + on-disk filename. */
export interface MoonshineModelFile {
  repoPath: string;
  file: string;
  /**
   * Absolute download URL override for files NOT hosted on the descriptor's HF
   * repo. Absent → the standard HF resolve URL is built from repo + repoPath.
   * Currently unused (every model resolves from its repo — the AR streaming
   * set moved to an HF mirror); kept as the seam for consumer-side mirrors.
   */
  url?: string;
}

export interface MoonshineModelDescriptor {
  id: string;
  label: string;
  language: SttLanguage;
  variant: "streaming" | "batch";
  /** HF repo (org/name) the fetch script and browser origin download from. */
  repo: string;
  /** Subdirectory inside the models dir (MOONSHINE_MODEL_PATH/<dir>). */
  dir: string;
  files: Record<string, MoonshineModelFile>;
  bosId: number;
  eosId: number;
  /** Hard decode-step cap (position-embedding limit or generation max_length). */
  maxTokens: number;
  /** Batch family only: decoder KV geometry (streaming reads its config file). */
  batch?: { depth: number; heads: number; headDim: number; hiddenSize: number };
}

export const MOONSHINE_MODELS: Record<string, MoonshineModelDescriptor> = {
  "moonshine-streaming-tiny-en": {
    id: "moonshine-streaming-tiny-en",
    label: "Moonshine streaming tiny (EN)",
    language: "en",
    variant: "streaming",
    repo: "moonshine-ai/moonshine-streaming",
    dir: "streaming-tiny-en",
    files: {
      frontend: { repoPath: "onnx/tiny/frontend.ort", file: "frontend.ort" },
      encoder: { repoPath: "onnx/tiny/encoder.ort", file: "encoder.ort" },
      adapter: { repoPath: "onnx/tiny/adapter.ort", file: "adapter.ort" },
      crossKv: { repoPath: "onnx/tiny/cross_kv.ort", file: "cross_kv.ort" },
      decoderKv: { repoPath: "onnx/tiny/decoder_kv.ort", file: "decoder_kv.ort" },
      tokenizer: { repoPath: "onnx/tiny/tokenizer.json", file: "tokenizer.json" },
      streamingConfig: { repoPath: "onnx/tiny/streaming_config.json", file: "streaming_config.json" },
    },
    // streaming_config.json: bos_id 1, eos_id 2 (loaded and verified at runtime;
    // mirrored here as the decode-loop bootstrap before the file is read).
    bosId: 1,
    eosId: 2,
    // Streaming decoder positions comfortably exceed a 60 s clip's token count;
    // 512 mirrors the batch family cap and bounds a degenerate never-EOS loop.
    maxTokens: 512,
  },
  "moonshine-streaming-tiny-ar": {
    id: "moonshine-streaming-tiny-ar",
    label: "Moonshine streaming tiny (AR) official",
    language: "ar",
    variant: "streaming",
    // Byte-identical HF MIRROR of the official Useful Sensors artifacts
    // (quantized_26_08_24; upstream: download.moonshine.ai, which sends no
    // CORS headers and so can't serve browsers). MIT — the streaming family is
    // MIT per the upstream LICENSE, verified 2026-09-03 (an earlier note here
    // wrongly said Community License; that license covers only the legacy
    // NON-streaming multilingual models). Per-file sha256 pins live in
    // apps/runner/Dockerfile; the tokenizer carries the official vocabulary
    // (from the MIT moonshine-ai checkpoint repo) and decodes official token
    // ids correctly.
    repo: "Drmoyassine/moonshine-streaming-tiny-ar-ort",
    dir: "streaming-tiny-ar",
    files: {
      frontend: { repoPath: "frontend.model.ort", file: "frontend.model.ort" },
      // AR frontend quirk: frontend.model.ort is a ~23 KB GRAPH whose three
      // weight tensors are INPUTS; frontend.weights.ort is a blob graph run
      // ONCE at load whose outputs (matched by name) feed every frontend run.
      frontendWeights: { repoPath: "frontend.weights.ort", file: "frontend.weights.ort" },
      encoder: { repoPath: "encoder.ort", file: "encoder.ort" },
      adapter: { repoPath: "adapter.ort", file: "adapter.ort" },
      crossKv: { repoPath: "cross_kv.ort", file: "cross_kv.ort" },
      decoderKv: { repoPath: "decoder_kv.ort", file: "decoder_kv.ort" },
      tokenizer: { repoPath: "tokenizer.json", file: "tokenizer.json" },
      streamingConfig: { repoPath: "streaming_config.json", file: "streaming_config.json" },
    },
    bosId: 1,
    eosId: 2,
    maxTokens: 512,
  },
  "moonshine-batch-base-en": {
    id: "moonshine-batch-base-en",
    label: "Moonshine base (EN) int8",
    language: "en",
    variant: "batch",
    repo: "onnx-community/moonshine-base-ONNX",
    dir: "batch-base-en",
    files: {
      encoder: { repoPath: "onnx/encoder_model_int8.onnx", file: "encoder_model_int8.onnx" },
      decoder: {
        repoPath: "onnx/decoder_model_merged_int8.onnx",
        file: "decoder_model_merged_int8.onnx",
      },
      tokenizer: { repoPath: "tokenizer.json", file: "tokenizer.json" },
    },
    // generation_config.json: bos 1 / eos 2; config.json: positions ≤ 512.
    bosId: 1,
    eosId: 2,
    maxTokens: 512,
    // config.json: 8 layers × 8 heads, hidden 416.
    batch: { depth: 8, heads: 8, headDim: 52, hiddenSize: 416 },
  },
};

export type MoonshineModelId = keyof typeof MOONSHINE_MODELS;

/**
 * Slot-1 default per language — SERVER side (runner / moonshine-server).
 * AR is the official streaming artifacts: they decode long clips cleanly where
 * every HF-checkpoint export looped past ~2 s (spike 2026-09-02).
 */
export const DEFAULT_STT_MODEL: Record<SttLanguage, MoonshineModelId> = {
  en: "moonshine-streaming-tiny-en",
  ar: "moonshine-streaming-tiny-ar",
};

/**
 * Slot-1 default per language — BROWSER side. Identical to the server map
 * since 0.4.4: the official AR streaming artifacts load from a CORS-open HF
 * mirror (byte-identical to the official CDN set — see the descriptor), and
 * single-threaded WASM decodes them at RTF ≈ 0.19 (measured 2026-09-03, same
 * as native), so there is no reason for the browser to sit on batch AR.
 * Kept as a separate exported map (not collapsed into DEFAULT_STT_MODEL) so
 * the browser can diverge again if a future artifact set warrants it.
 */
export const BROWSER_DEFAULT_STT_MODEL: Record<SttLanguage, MoonshineModelId> = {
  en: "moonshine-streaming-tiny-en",
  ar: "moonshine-streaming-tiny-ar",
};

/** Slot-2 EN escalation (strictly stronger, batch family). */
export const ESCALATION_STT_MODEL: Record<SttLanguage, MoonshineModelId | null> = {
  en: "moonshine-batch-base-en",
  ar: null, // AR escalates straight to the external gateway (ROADMAP Track 3)
};

/**
 * Slot-1 model for a language, unless the caller forced a KNOWN model id (an
 * unknown forced string falls back to the default — the server engine does the
 * same for its per-slot construction). Both engines resolve through this so the
 * forced-id semantics stay identical; the two default maps currently agree
 * (see BROWSER_DEFAULT_STT_MODEL).
 */
export function resolveModelId(
  forced: string | undefined,
  language: SttLanguage,
  defaults: Record<SttLanguage, MoonshineModelId> = DEFAULT_STT_MODEL,
): MoonshineModelId {
  if (forced && MOONSHINE_MODELS[forced]) return forced as MoonshineModelId;
  return defaults[language];
}

export const HF_RESOLVE_BASE = "https://huggingface.co";

/** Download URL for one file of a descriptor (fetch script + browser origin). */
export function fileUrl(desc: MoonshineModelDescriptor, role: string): string {
  const f = desc.files[role];
  if (!f) throw new Error(`model ${desc.id} has no file role "${role}"`);
  // Per-file absolute override (official CDN artifacts) wins over the HF URL.
  if (f.url) return f.url;
  return `${HF_RESOLVE_BASE}/${desc.repo}/resolve/main/${f.repoPath}`;
}

/** streaming_config.json as shipped in the EN streaming artifact set. */
export interface StreamingConfig {
  depth: number;
  nheads: number;
  head_dim: number;
  vocab_size: number;
  bos_id: number;
  eos_id: number;
  frame_len: number;
  total_lookahead: number;
  frontend_state_shapes: {
    sample_buffer: number[];
    sample_len: number[];
    conv1_buffer: number[];
    conv2_buffer: number[];
    frame_count: number[];
  };
}
