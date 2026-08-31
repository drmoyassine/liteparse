import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MOONSHINE_MODELS } from "../src/engines/moonshine/shared/models.js";
import { encodeWavPcm16 } from "../src/engines/moonshine/shared/wav.js";

/**
 * Hermetic tests for the Moonshine server engine: model-path detection, both
 * decode loops (streaming `.ort` chain and batch merged decoder), confidence,
 * tashkeel policy, and lifecycle — all with onnxruntime-node MOCKED (no model
 * binaries; real-model transcription runs in apps/runner's stt-pipeline test,
 * which skips when models are absent).
 *
 * The engine keeps module-level singletons, so every test loads a FRESH module
 * copy (vi.resetModules + doMock) against its own mocks — the rapidocr-server
 * test pattern.
 */

// ── fake model trees ──────────────────────────────────────────────────────────

/** Vocab mirroring the real tokenizers' SentencePiece layout (shared/tokens.ts). */
const EN_TOKENIZER = JSON.stringify({
  model: { vocab: { "<unk>": 0, "<s>": 1, "</s>": 2, "▁hello": 12, "▁world": 13 } },
});
const AR_TOKENIZER = JSON.stringify({
  model: { vocab: { "<unk>": 0, "<s>": 1, "</s>": 2, "مُحَمَّد": 20 } },
});
/** Geometry field set the engine validates at load (real values probed 2026-09-01). */
const STREAMING_CFG = JSON.stringify({
  depth: 2,
  nheads: 2,
  head_dim: 4,
  vocab_size: 40,
  bos_id: 1,
  eos_id: 2,
  frame_len: 80,
  total_lookahead: 16,
  frontend_state_shapes: {
    sample_buffer: [1, 79],
    sample_len: [1],
    conv1_buffer: [1, 320, 4],
    conv2_buffer: [1, 640, 4],
    frame_count: [1],
  },
});

/** Full models root (all three descriptors) with fake files per descriptor. */
function fakeModelRoot(exclude?: (file: string) => boolean): string {
  const root = mkdtempSync(join(tmpdir(), "moonshine-server-"));
  for (const desc of Object.values(MOONSHINE_MODELS)) {
    const dir = join(root, desc.dir);
    mkdirSync(dir, { recursive: true });
    for (const f of Object.values(desc.files)) {
      if (exclude?.(f.file)) continue;
      const content =
        f.file === "tokenizer.json"
          ? desc.language === "ar"
            ? AR_TOKENIZER
            : EN_TOKENIZER
          : f.file === "streaming_config.json"
            ? STREAMING_CFG
            : "fake-onnx";
      writeFileSync(join(dir, f.file), content);
    }
  }
  return root;
}

/** 16 kHz mono WAV of `seconds` constant-level audio (model-rate input: no resample). */
function testWav(seconds = 0.1): Uint8Array {
  return encodeWavPcm16(new Float32Array(Math.round(seconds * 16000)).fill(0.25), 16000);
}

// ── mocked ort ────────────────────────────────────────────────────────────────

class FakeTensor {
  constructor(
    public type: string,
    public data: unknown,
    public dims: number[],
  ) {}
}

interface Script {
  /** Streaming decoder token script (default "hello world" then EOS). */
  streamingTokens?: number[];
  /** Batch decoder token script (default diacritized Arabic then EOS). */
  batchTokens?: number[];
  /** Logits row width / fake vocab size. */
  vocabSize?: number;
  /** Logit value placed at the scripted token id. */
  boost?: number;
}

interface RecordedRun {
  /** basename of the session's file, e.g. "decoder_kv.ort". */
  path: string;
  /** Feed map as passed (tensor objects by reference). */
  feeds: Record<string, FakeTensor>;
  /** Output map (for present.*→past threading assertions). */
  outputs: Record<string, FakeTensor>;
}

function mockOrtFactory(script: Script = {}) {
  const tokens = {
    streaming: script.streamingTokens ?? [12, 13, 2],
    batch: script.batchTokens ?? [20, 2],
  };
  const vocabSize = script.vocabSize ?? 40;
  const boost = script.boost ?? 5;

  const created: string[] = [];
  const runs: RecordedRun[] = [];
  /** Decode-chain step tracking keyed on the KV tensor the engine threads back
   *  in (step N+1's feed IS step N's output object) — so concurrent transcribes
   *  each play the full token script instead of interleaving one shared counter. */
  const chainStep = new WeakMap<object, number>();

  const logitsFor = (decoder: string, step: number): FakeTensor => {
    const seq = decoder === "decoder_kv.ort" ? tokens.streaming : tokens.batch;
    const logits = new Float32Array(vocabSize);
    const id = seq[step];
    if (id !== undefined) logits[id] = boost;
    return new FakeTensor("float32", logits, [1, 1, vocabSize]);
  };

  const create = vi.fn(async (path: string) => {
    created.push(basename(path));
    const name = basename(path);
    const T = (dims: number[]) => new FakeTensor("float32", new Float32Array(dims.reduce((a, b) => a * b, 0)), dims);
    const run = async (feeds: Record<string, FakeTensor>) => {
      const outputs: Record<string, FakeTensor> = {};
      switch (name) {
        case "frontend.ort":
          outputs.features = T([1, 5, 320]);
          break;
        case "encoder.ort":
          outputs.encoded = T([1, 5, 288]);
          break;
        case "adapter.ort":
          outputs.memory = T([1, 5, 288]);
          break;
        case "cross_kv.ort":
          outputs.k_cross = T([2, 1, 2, 5, 4]);
          outputs.v_cross = T([2, 1, 2, 5, 4]);
          break;
        case "decoder_kv.ort": {
          // No entry = fresh chain (the engine builds a new empty k_self tensor
          // per transcribe); otherwise the fed k_self is our previous out_k_self.
          const step = (chainStep.get(feeds["k_self"]!) ?? -1) + 1;
          outputs.logits = logitsFor(name, step);
          outputs.out_k_self = T([2, 1, 2, step + 1, 4]);
          outputs.out_v_self = T([2, 1, 2, step + 1, 4]);
          chainStep.set(outputs.out_k_self, step);
          break;
        }
        case "encoder_model_int8.onnx":
          outputs.last_hidden_state = T([1, 5, 288]);
          break;
        case "decoder_model_merged_int8.onnx": {
          const step = (chainStep.get(feeds["past_key_values.0.decoder.key"]!) ?? -1) + 1;
          outputs.logits = logitsFor(name, step);
          for (let l = 0; l < 8; l++) {
            for (const kind of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
              outputs[`present.${l}.${kind}`] = T([1, 8, step + 1, 36]);
            }
          }
          chainStep.set(outputs["present.0.decoder.key"]!, step);
          break;
        }
        default:
          throw new Error(`unexpected session file ${name}`);
      }
      runs.push({ path: name, feeds, outputs });
      return outputs;
    };
    return { run, release: vi.fn(), path };
  });

  return { InferenceSession: { create }, Tensor: FakeTensor, created, runs };
}

/** Fresh module copy with a pre-built ort mock (same instance the engine imports). */
async function freshModule(script: Script = {}) {
  const ort = mockOrtFactory(script);
  vi.resetModules();
  vi.doMock("onnxruntime-node", () => ort as unknown as Record<string, unknown>);
  const mod = await import("../src/stt/moonshine-server.js");
  return { mod, ort };
}

/** Fresh module copy whose onnxruntime-node import REJECTS (not installed). */
async function freshModuleWithoutOrt() {
  vi.resetModules();
  vi.doMock("onnxruntime-node", () => {
    throw new Error("Cannot find module 'onnxruntime-node'");
  });
  return await import("../src/stt/moonshine-server.js");
}

// ── lifecycle ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const prevEnv = process.env.MOONSHINE_MODEL_PATH;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("onnxruntime-node");
  if (prevEnv === undefined) delete process.env.MOONSHINE_MODEL_PATH;
  else process.env.MOONSHINE_MODEL_PATH = prevEnv;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("createMoonshineServerEngine — model loading", () => {
  it("rejects with an install hint when onnxruntime-node cannot be imported", async () => {
    const mod = await freshModuleWithoutOrt();
    await expect(mod.createMoonshineServerEngine()).rejects.toThrow(/onnxruntime-node/);
  });

  it("rejects clearly when no model directory exists anywhere", async () => {
    delete process.env.MOONSHINE_MODEL_PATH;
    const { mod } = await freshModule();
    await expect(mod.createMoonshineServerEngine({ debug: false })).rejects.toThrow(
      /Moonshine models not found/,
    );
  });

  it("fails loudly when MOONSHINE_MODEL_PATH points at a missing directory", async () => {
    process.env.MOONSHINE_MODEL_PATH = join(tmpdir(), "definitely-not-here");
    const { mod } = await freshModule();
    await expect(mod.createMoonshineServerEngine({ debug: false })).rejects.toThrow(
      /MOONSHINE_MODEL_PATH is set but does not exist/,
    );
  });

  it("fails loudly when the explicit modelPath is missing", async () => {
    const { mod } = await freshModule();
    await expect(
      mod.createMoonshineServerEngine({ debug: false, modelPath: join(tmpdir(), "nope") }),
    ).rejects.toThrow(/modelPath is set but does not exist/);
  });

  it("rejects with the missing file names when a model dir is incomplete", async () => {
    const root = fakeModelRoot((f) => f === "decoder_kv.ort");
    tempDirs.push(root);
    const { mod } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    await expect(engine.transcribe(testWav())).rejects.toThrow(/decoder_kv\.ort/);
  });
});

describe("transcribe — EN streaming family", () => {
  it("runs the full chain and decodes scripted tokens to text + confidence", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });

    const result = await engine.transcribe(testWav());
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    // Equal-length tokens: confidence = per-token prob = e^5 / (e^5 + 39).
    expect(result.confidence).toBeCloseTo(Math.exp(5) / (Math.exp(5) + 39), 6);

    // Slot-1 EN = the streaming five-graph chain, not the batch pair.
    expect(ort.created).toContain("frontend.ort");
    expect(ort.created).toContain("decoder_kv.ort");
    expect(ort.created).not.toContain("decoder_model_merged_int8.onnx");

    // Whole-clip frontend feed at model rate, one token per decoder step.
    const frontend = ort.runs.find((r) => r.path === "frontend.ort")!;
    expect(frontend.feeds["audio_chunk"]!.dims).toEqual([1, 1600]);
    const decoderRuns = ort.runs.filter((r) => r.path === "decoder_kv.ort");
    expect(decoderRuns).toHaveLength(3); // "hello", "world", EOS
    expect(decoderRuns[0]!.feeds["token"]!.dims).toEqual([1, 1]);
    // First decoder feed: BOS token and empty self-KV [depth,1,heads,0,headDim].
    expect(Array.from(decoderRuns[0]!.feeds["token"]!.data as BigInt64Array)).toEqual([1n]);
    expect(decoderRuns[0]!.feeds["k_self"]!.dims).toEqual([2, 1, 2, 0, 4]);
  });

  it("clamps the clip to maxSeconds before the frontend", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root, maxSeconds: 0.05 });
    await engine.transcribe(testWav(0.2));
    const frontend = ort.runs.find((r) => r.path === "frontend.ort")!;
    expect(frontend.feeds["audio_chunk"]!.dims).toEqual([1, 800]);
  });

  it("returns empty text for clips shorter than one frame (no decode)", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    const result = await engine.transcribe(testWav(0.001)); // 16 samples < frame_len 80
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    expect(ort.runs).toHaveLength(0);
  });
});

describe("transcribe — AR batch family", () => {
  it("runs the merged-decoder KV flow and strips tashkeel by default", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });

    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("محمد"); // مُحَمَّد minus diacritics
    expect(result.language).toBe("ar");

    // Batch family files, not the streaming chain.
    expect(ort.created).toContain("encoder_model_int8.onnx");
    expect(ort.created).not.toContain("frontend.ort");
    // Raw waveform into the encoder (ConvFrontend baked in — spike-verified).
    const enc = ort.runs.find((r) => r.path === "encoder_model_int8.onnx")!;
    expect(enc.feeds["input_values"]!.dims).toEqual([1, 1600]);

    // Merged-decoder cache flow: use_cache_branch 0 → 1, present.* threaded into past.
    const dec = ort.runs.filter((r) => r.path === "decoder_model_merged_int8.onnx");
    expect(dec).toHaveLength(2); // token, EOS
    expect(Array.from(dec[0]!.feeds["use_cache_branch"]!.data as Uint8Array)).toEqual([0]);
    expect(Array.from(dec[1]!.feeds["use_cache_branch"]!.data as Uint8Array)).toEqual([1]);
    // Empty past on step 0, present.* identity-threaded on step 1.
    expect(dec[0]!.feeds["past_key_values.0.decoder.key"]!.dims).toEqual([1, 8, 0, 36]);
    expect(dec[1]!.feeds["past_key_values.0.decoder.key"]).toBe(
      dec[0]!.outputs["present.0.decoder.key"],
    );
  });

  it("keeps diacritics when keepDiacritics is set", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({
      debug: false,
      modelPath: root,
      keepDiacritics: true,
    });
    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("مُحَمَّد");
  });

  it("holds encoder KV constant across steps (broken cache-branch presents)", async () => {
    // Regression: the merged export's use_cache_branch=1 path emits [0,8,1,36]
    // encoder-KV presents; threading them crashes step 3 (probed 2026-09-01).
    // Only decoder self-KV may be threaded — cross-attention KV is source-only.
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule({ batchTokens: [20, 20, 2] });
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("محمدمحمد");
    const dec = ort.runs.filter((r) => r.path === "decoder_model_merged_int8.onnx");
    expect(dec).toHaveLength(3);
    // Self-KV threads: step N+1 feeds step N's present.
    expect(dec[1]!.feeds["past_key_values.0.decoder.key"]).toBe(
      dec[0]!.outputs["present.0.decoder.key"],
    );
    expect(dec[2]!.feeds["past_key_values.0.decoder.key"]).toBe(
      dec[1]!.outputs["present.0.decoder.key"],
    );
    // Encoder past is never threaded from the (broken) presents: every step
    // feeds the same initial empty tensors — the graph recomputes cross-KV
    // from encoder_hidden_states on the cache branch.
    expect(dec[1]!.feeds["past_key_values.0.encoder.key"]).toBe(
      dec[0]!.feeds["past_key_values.0.encoder.key"],
    );
    expect(dec[2]!.feeds["past_key_values.0.encoder.key"]).toBe(
      dec[0]!.feeds["past_key_values.0.encoder.key"],
    );
    expect(dec[2]!.feeds["past_key_values.0.encoder.key"]!.dims).toEqual([1, 8, 0, 36]);
  });
});

describe("model selection", () => {
  it("forces a known model id across languages", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({
      debug: false,
      modelPath: root,
      model: "moonshine-batch-base-en",
    });
    await engine.transcribe(testWav(), { language: "ar" });
    expect(ort.created).toContain("decoder_model_merged_int8.onnx");
    expect(ort.runs.some((r) => r.path === "frontend.ort")).toBe(false);
  });

  it("falls back to the slot-1 default for unknown model strings", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({
      debug: false,
      modelPath: root,
      model: "whisper-large", // unknown id: (string & {}) accepts it, runtime falls back
    });
    await engine.transcribe(testWav());
    expect(ort.created).toContain("frontend.ort");
  });
});

describe("engine contract", () => {
  it("propagates WavError for non-WAV bytes (the runner maps this to 422)", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    // resetModules gives the engine its own wav.js copy, so assert on the
    // typed shape (name + code) rather than cross-graph instanceof.
    const err = await engine.transcribe(new TextEncoder().encode("not audio")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "WavError", code: "not_wav" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    const controller = new AbortController();
    controller.abort();
    await expect(engine.transcribe(testWav(), { signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(ort.runs).toHaveLength(0);
  });

  it("warms a language's slot-1 model without any audio", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    await engine.warm("ar");
    expect(ort.created).toContain("decoder_model_merged_int8.onnx");
    expect(ort.runs).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("dispose releases sessions; the next engine reloads them", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const e1 = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    await e1.transcribe(testWav());
    const loadsAfterFirst = ort.created.length;
    e1.dispose();

    const e2 = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    const result = await e2.transcribe(testWav());
    expect(result.text).toBe("hello world");
    expect(ort.created.length).toBe(loadsAfterFirst * 2); // everything recreated
  });

  it("shares one model load across concurrent transcribes of the same language", async () => {
    const root = fakeModelRoot();
    tempDirs.push(root);
    const { mod, ort } = await freshModule();
    const engine = await mod.createMoonshineServerEngine({ debug: false, modelPath: root });
    const [a, b] = await Promise.all([engine.transcribe(testWav()), engine.transcribe(testWav())]);
    expect(a.text).toBe("hello world");
    expect(b.text).toBe("hello world");
    // One session per graph despite two racing first-calls (loading dedupe).
    expect(ort.created.filter((f) => f === "frontend.ort")).toHaveLength(1);
  });
});
