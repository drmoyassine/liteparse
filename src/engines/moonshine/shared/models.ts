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
 *   AR  streaming tiny — OFFICIAL Useful Sensors artifacts on download.moonshine.ai
 *       (quantized_26_08_24, verified 2026-09-02: clean one-shot AND chunked decode
 *       past 2 s where the HF checkpoint weights loop). Moonshine Community License
 *       — fetch/bake only, never npm-redistribute. Same five-graph layout as EN
 *       plus one quirk: the frontend ships as graph + weights pair (see
 *       frontendWeights below). Browsers CANNOT fetch these files (the CDN sends
 *       no CORS headers), so the browser default for AR stays batch.
 *   AR  batch tiny int8 — onnx-community/moonshine-tiny-ar-ONNX (license
 *       "other": fetched/baked, never npm-redistributed). Encoder input is RAW
 *       waveform (`input_values`); past-KV layout is transformers.js [1,heads,T,headDim].
 *   EN  batch base int8 — onnx-community/moonshine-base-ONNX (MIT); same export
 *       family as AR batch (config: 8 layers × 8 heads × 52, positions ≤ 512).
 */

export type SttLanguage = "en" | "ar";

/** File roles per family; values are repo-relative path + on-disk filename. */
export interface MoonshineModelFile {
  repoPath: string;
  file: string;
  /**
   * Absolute download URL override for files NOT hosted on the descriptor's HF
   * repo (the official AR streaming artifacts live on download.moonshine.ai).
   * Absent → the standard HF resolve URL is built from repo + repoPath.
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

/**
 * Official Useful Sensors CDN release of the AR streaming artifacts (the only
 * host of these graphs; version-pinned directory like every other pin here).
 * Moonshine Community License — fetch/bake, never npm-redistribute.
 */
export const AR_STREAMING_CDN =
  "https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/";

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
    // Sidecars pin the MIT HF checkpoint repo (same tokenizer vocabulary as the
    // official artifacts — verified by decoding official token ids through it);
    // the six graphs come from the official CDN (Community License).
    repo: "moonshine-ai/moonshine-streaming-tiny-ar",
    dir: "streaming-tiny-ar",
    files: {
      frontend: {
        repoPath: "frontend.model.ort",
        file: "frontend.model.ort",
        url: `${AR_STREAMING_CDN}frontend.model.ort`,
      },
      // AR frontend quirk: frontend.model.ort is a ~23 KB GRAPH whose three
      // weight tensors are INPUTS; frontend.weights.ort is a blob graph run
      // ONCE at load whose outputs (matched by name) feed every frontend run.
      frontendWeights: {
        repoPath: "frontend.weights.ort",
        file: "frontend.weights.ort",
        url: `${AR_STREAMING_CDN}frontend.weights.ort`,
      },
      encoder: { repoPath: "encoder.ort", file: "encoder.ort", url: `${AR_STREAMING_CDN}encoder.ort` },
      adapter: { repoPath: "adapter.ort", file: "adapter.ort", url: `${AR_STREAMING_CDN}adapter.ort` },
      crossKv: {
        repoPath: "cross_kv.ort",
        file: "cross_kv.ort",
        url: `${AR_STREAMING_CDN}cross_kv.ort`,
      },
      decoderKv: {
        repoPath: "decoder_kv.ort",
        file: "decoder_kv.ort",
        url: `${AR_STREAMING_CDN}decoder_kv.ort`,
      },
      tokenizer: { repoPath: "tokenizer.json", file: "tokenizer.json" },
      // Not in the HF repo (checkpoint only) — the config ships with the CDN set.
      streamingConfig: {
        repoPath: "streaming_config.json",
        file: "streaming_config.json",
        url: `${AR_STREAMING_CDN}streaming_config.json`,
      },
    },
    bosId: 1,
    eosId: 2,
    maxTokens: 512,
  },
  "moonshine-batch-tiny-ar": {
    id: "moonshine-batch-tiny-ar",
    label: "Moonshine tiny (AR) int8",
    language: "ar",
    variant: "batch",
    repo: "onnx-community/moonshine-tiny-ar-ONNX",
    dir: "batch-tiny-ar",
    files: {
      encoder: { repoPath: "onnx/encoder_model_int8.onnx", file: "encoder_model_int8.onnx" },
      decoder: {
        repoPath: "onnx/decoder_model_merged_int8.onnx",
        file: "decoder_model_merged_int8.onnx",
      },
      tokenizer: { repoPath: "tokenizer.json", file: "tokenizer.json" },
    },
    // generation_config.json: bos 1 / eos 2 / max_length 194.
    bosId: 1,
    eosId: 2,
    maxTokens: 194,
    // Probed: present.* come back [1,8,t,36]; 6 layers (present.0–5); hidden 288.
    batch: { depth: 6, heads: 8, headDim: 36, hiddenSize: 288 },
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
 * Slot-1 default per language — BROWSER side. AR stays batch: the official CDN
 * sends no Access-Control-Allow-Origin (probed 2026-09-02), so a browser tab
 * cannot fetch the streaming AR graphs, while HF-hosted batch AR loads fine.
 * A consumer CAN still force `model: "moonshine-streaming-tiny-ar"` if they
 * mirror the files behind their own origin.
 */
export const BROWSER_DEFAULT_STT_MODEL: Record<SttLanguage, MoonshineModelId> = {
  en: "moonshine-streaming-tiny-en",
  ar: "moonshine-batch-tiny-ar",
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
 * forced-id semantics stay identical; they differ only in the default map
 * (browser AR stays batch — see BROWSER_DEFAULT_STT_MODEL).
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
