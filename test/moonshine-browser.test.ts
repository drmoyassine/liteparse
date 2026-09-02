import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOrigin } from "../src/worker/model-origin.js";
import { MOONSHINE_MODELS } from "../src/engines/moonshine/shared/models.js";
import { encodeWavPcm16 } from "../src/engines/moonshine/shared/wav.js";

/**
 * Hermetic tests for the browser Moonshine engine: model loading through
 * resolveModel (origin → IndexedDB read-through; node has no IndexedDB so the
 * origin is always hit), both decode families, the ENGINE-SIDE confidence gate
 * (the browser counterpart of the runner service's gate), the LRU, the
 * AudioContext container fallback, and the stt-lab telemetry line — all with
 * onnxruntime-web/wasm MOCKED (no model binaries). Same pattern as
 * moonshine-server.test.ts; real-model runs are the consumer's browser smoke.
 */

// ── fakes ─────────────────────────────────────────────────────────────────────

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

class FakeTensor {
  constructor(
    public type: string,
    public data: unknown,
    public dims: number[],
  ) {}
}

interface Script {
  streamingTokens?: number[];
  batchTokens?: number[];
  vocabSize?: number;
  /** Logit value placed at the scripted token id (low ⇒ trips the gate). */
  boost?: number;
}

interface RecordedRun {
  /** the artifact tag the fake origin served, e.g. "decoderKv". */
  tag: string;
  feeds: Record<string, FakeTensor>;
  outputs: Record<string, FakeTensor>;
}

/** Origin serving tagged bytes per descriptor id ("<modelId>/<role>"). */
function fakeOrigin(): ModelOrigin & { served: string[] } {
  const served: string[] = [];
  return {
    served,
    async fetchModel(d) {
      served.push(d.id);
      const role = d.id.slice(d.id.indexOf("/") + 1);
      if (role === "tokenizer") {
        const ar = d.id.startsWith("moonshine-batch-tiny-ar") || d.id.startsWith("moonshine-streaming-tiny-ar");
        return new TextEncoder().encode(ar ? AR_TOKENIZER : EN_TOKENIZER);
      }
      if (role === "streamingConfig") return new TextEncoder().encode(STREAMING_CFG);
      return new TextEncoder().encode(role); // binary marker: create() reads it back
    },
  };
}

function mockOrtFactory(script: Script = {}) {
  const tokens = {
    streaming: script.streamingTokens ?? [12, 13, 2],
    batch: script.batchTokens ?? [20, 2],
  };
  const vocabSize = script.vocabSize ?? 40;
  const boost = script.boost ?? 5;

  const created: string[] = [];
  const released: string[] = [];
  const runs: RecordedRun[] = [];
  /** Decode-chain step tracking keyed on the KV tensor the engine threads back
   *  in (step N+1's feed IS step N's output object) — concurrent transcribes
   *  each play the full token script instead of interleaving one shared counter. */
  const chainStep = new WeakMap<object, number>();

  const logitsFor = (decoder: string, step: number): FakeTensor => {
    const seq = decoder === "decoderKv" ? tokens.streaming : tokens.batch;
    const logits = new Float32Array(vocabSize);
    const id = seq[step];
    if (id !== undefined) logits[id] = boost;
    return new FakeTensor("float32", logits, [1, 1, vocabSize]);
  };

  const create = vi.fn(async (bytes: Uint8Array) => {
    // resolveModel handed us whatever the origin served; binaries carry their
    // role name as the payload, so decode it back to know which graph this is.
    const tag = new TextDecoder().decode(bytes);
    created.push(tag);
    const T = (dims: number[]) =>
      new FakeTensor("float32", new Float32Array(dims.reduce((a, b) => a * b, 0)), dims);
    const run = async (feeds: Record<string, FakeTensor>) => {
      const outputs: Record<string, FakeTensor> = {};
      switch (tag) {
        case "frontend":
          outputs.features = T([1, 5, 320]);
          break;
        case "frontendWeights":
          // AR official artifacts: blob graph whose OUTPUTS are the frontend
          // graph's weight INPUTS, matched by name (bindFrontendWeights merges).
          outputs["onnx::MatMul_124_add_tensor_add_tensor"] = T([80, 320]);
          outputs["onnx::Conv_127_add_tensor_add_tensor"] = T([640, 320, 5]);
          outputs["onnx::Conv_134_add_tensor_add_tensor"] = T([320, 640, 5]);
          break;
        case "encoder":
          // Streaming encoder (features in) and batch encoder (input_values in)
          // are distinguished by feed name.
          if (feeds["features"]) outputs.encoded = T([1, 5, 288]);
          else outputs.last_hidden_state = T([1, 5, 288]);
          break;
        case "adapter":
          outputs.memory = T([1, 5, 288]);
          break;
        case "crossKv":
          outputs.k_cross = T([2, 1, 2, 5, 4]);
          outputs.v_cross = T([2, 1, 2, 5, 4]);
          break;
        case "decoderKv": {
          const step = (chainStep.get(feeds["k_self"]!) ?? -1) + 1;
          outputs.logits = logitsFor(tag, step);
          outputs.out_k_self = T([2, 1, 2, step + 1, 4]);
          outputs.out_v_self = T([2, 1, 2, step + 1, 4]);
          chainStep.set(outputs.out_k_self, step);
          break;
        }
        case "decoder": {
          const step = (chainStep.get(feeds["past_key_values.0.decoder.key"]!) ?? -1) + 1;
          outputs.logits = logitsFor(tag, step);
          for (let l = 0; l < 8; l++) {
            for (const kind of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
              outputs[`present.${l}.${kind}`] = T([1, 8, step + 1, 36]);
            }
          }
          chainStep.set(outputs["present.0.decoder.key"]!, step);
          break;
        }
        default:
          throw new Error(`unexpected artifact tag ${tag}`);
      }
      runs.push({ tag, feeds, outputs });
      return outputs;
    };
    return { run, release: () => void released.push(tag) };
  });

  return { env: { wasm: {} }, InferenceSession: { create }, Tensor: FakeTensor, created, released, runs };
}

/** Fresh module copy with a pre-built ort mock + real shared modules. */
async function freshModule(script: Script = {}) {
  const ort = mockOrtFactory(script);
  vi.resetModules();
  vi.doMock("onnxruntime-web/wasm", () => ort as unknown as Record<string, unknown>);
  const mod = await import("../src/engines/moonshine/moonshine-browser.js");
  return { mod, ort };
}

/** 16 kHz mono WAV of `seconds` constant-level audio (model-rate: no resample). */
function testWav(seconds = 0.1): Uint8Array {
  return encodeWavPcm16(new Float32Array(Math.round(seconds * 16000)).fill(0.25), 16000);
}

const tempGlobals: { key: string; had: boolean; value: unknown }[] = [];
function setGlobal(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>;
  tempGlobals.push({ key, had: key in g, value: g[key] });
  g[key] = value;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("onnxruntime-web/wasm");
  vi.restoreAllMocks();
  for (const { key, had, value } of tempGlobals.splice(0).reverse()) {
    if (had) (globalThis as Record<string, unknown>)[key] = value;
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

// The engine reads self.location/self.crossOriginIsolated when configuring ort.
// Re-applied per test: the afterEach global restore deletes it (node has none).
const ORIGIN = "https://app.example";
beforeEach(() => {
  setGlobal("self", { location: { origin: ORIGIN } });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createMoonshineSttEngine — EN streaming family", () => {
  it("loads via the origin, decodes scripted tokens, and passes the gate", async () => {
    const origin = fakeOrigin();
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: origin });

    const result = await engine.transcribe(testWav());
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    // Equal-length tokens: confidence = per-token prob = e^5 / (e^5 + 39) ≥ 0.55 floor.
    expect(result.confidence).toBeCloseTo(Math.exp(5) / (Math.exp(5) + 39), 6);

    // Slot-1 EN = the streaming five-graph chain; every role came through the origin.
    expect(ort.created).toContain("frontend");
    expect(ort.created).not.toContain("decoder");
    for (const role of Object.keys(MOONSHINE_MODELS["moonshine-streaming-tiny-en"]!.files)) {
      expect(origin.served).toContain(`moonshine-streaming-tiny-en/${role}`);
    }

    // Whole-clip frontend feed at model rate; BOS + empty self-KV on step 0.
    const frontend = ort.runs.find((r) => r.tag === "frontend")!;
    expect(frontend.feeds["audio_chunk"]!.dims).toEqual([1, 1600]);
    const decoderRuns = ort.runs.filter((r) => r.tag === "decoderKv");
    expect(decoderRuns).toHaveLength(3); // "hello", "world", EOS
    expect(decoderRuns[0]!.feeds["k_self"]!.dims).toEqual([2, 1, 2, 0, 4]);
  });

  it("discards below-floor text (the engine-side gate → route under-yield)", async () => {
    // boost 0.2 over vocab 40 ⇒ per-token prob ≈ 0.0126 ≪ floor 0.55.
    const { mod } = await freshModule({ boost: 0.2 });
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    const result = await engine.transcribe(testWav());
    expect(result.text).toBe(""); // gate: non-empty text below floor is discarded
    expect(result.confidence).toBeLessThan(0.55);
    expect(result.language).toBe("en");
  });

  it("configures ort once with full-origin wasmPaths + single-thread without isolation", async () => {
    const { mod, ort } = await freshModule();
    await mod
      .createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() })
      .transcribe(testWav());
    const env = (ort as unknown as { env?: { wasm: { wasmPaths: string; numThreads: number } } }).env!;
    expect(env.wasm.wasmPaths).toBe("https://app.example/ort/");
    expect(env.wasm.numThreads).toBe(1); // self.crossOriginIsolated is unset here
  });
});

describe("createMoonshineSttEngine — AR batch family (forced; the browser default is streaming now)", () => {
  it("runs the merged-decoder flow and strips tashkeel by default", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      model: "moonshine-batch-tiny-ar",
    });

    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("محمد"); // مُحَمَّد minus diacritics
    expect(result.language).toBe("ar");

    // Batch pair (raw waveform in — ConvFrontend baked into the encoder).
    expect(ort.created).toContain("encoder");
    expect(ort.created).toContain("decoder");
    expect(ort.created).not.toContain("frontend");
    const enc = ort.runs.find((r) => r.tag === "encoder" && r.feeds["input_values"])!;
    expect(enc.feeds["input_values"]!.dims).toEqual([1, 1600]);

    // Merged-decoder cache flow: use_cache_branch 0 → 1; prefill cross-KV
    // threads once then freezes, decoder self-KV threads every step.
    const dec = ort.runs.filter((r) => r.tag === "decoder");
    expect(dec).toHaveLength(2);
    expect(Array.from(dec[0]!.feeds["use_cache_branch"]!.data as Uint8Array)).toEqual([0]);
    expect(Array.from(dec[1]!.feeds["use_cache_branch"]!.data as Uint8Array)).toEqual([1]);
    expect(dec[1]!.feeds["past_key_values.0.decoder.key"]).toBe(
      dec[0]!.outputs["present.0.decoder.key"],
    );
    expect(dec[1]!.feeds["past_key_values.0.encoder.key"]).toBe(
      dec[0]!.outputs["present.0.encoder.key"],
    );
  });

  it("keeps diacritics when keepDiacritics is set", async () => {
    const { mod } = await freshModule();
    const engine = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      model: "moonshine-batch-tiny-ar",
      keepDiacritics: true,
    });
    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("مُحَمَّد");
  });
});

describe("createMoonshineSttEngine — AR streaming family (the BROWSER default)", () => {
  it("binds the frontend weights pair and decodes through the streaming chain", async () => {
    // Slot-1 AR default (BROWSER map) = the official streaming artifacts via
    // the CORS-open HF mirror — no forced model needed anymore.
    const origin = fakeOrigin();
    const { mod, ort } = await freshModule({ streamingTokens: [20, 2] });
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: origin });

    const result = await engine.transcribe(testWav(), { language: "ar" });
    expect(result.text).toBe("محمد");
    expect(result.language).toBe("ar");

    expect(ort.created).toContain("frontend");
    expect(ort.created).toContain("frontendWeights");
    expect(ort.created).not.toContain("decoder");
    // Every role (weights pair included) came through the origin.
    for (const role of Object.keys(MOONSHINE_MODELS["moonshine-streaming-tiny-ar"]!.files)) {
      expect(origin.served).toContain(`moonshine-streaming-tiny-ar/${role}`);
    }
    // Weights blob run ONCE at bind; outputs threaded into the frontend by name.
    const weightRuns = ort.runs.filter((r) => r.tag === "frontendWeights");
    expect(weightRuns).toHaveLength(1);
    const frontend = ort.runs.find((r) => r.tag === "frontend")!;
    expect(frontend.feeds["onnx::MatMul_124_add_tensor_add_tensor"]).toBe(
      weightRuns[0]!.outputs["onnx::MatMul_124_add_tensor_add_tensor"],
    );
  });
});

describe("model lifecycle (LRU + dedupe)", () => {
  it("evicts the least-recently-used model at the cap and re-loads it on demand", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      maxLoadedModels: 1,
    });

    await engine.transcribe(testWav()); // EN streaming loads
    expect(ort.created).toContain("frontend");
    await engine.transcribe(testWav(), { language: "ar" }); // AR streaming loads → EN evicted
    expect(ort.released).toContain("frontend");
    // Residency is observed through the ort session tags (the public engine
    // handle deliberately exposes only transcribe/warm/dispose): AR's six
    // sessions (weights pair included) were created, EN's five are gone.

    // Re-visiting EN re-creates its sessions (AR evicted this time).
    // "frontendWeights" is the AR-STREAMING-only tag (EN streaming's frontend
    // is monolithic), so its presence in released proves the AR model — not
    // the EN one — was the evicted resident. (The AR transcribe itself
    // decoded EN-script ids the AR tokenizer skips → gated empty text, which
    // this test never asserts on.)
    const result = await engine.transcribe(testWav());
    expect(result.text).toBe("hello world");
    expect(ort.released).toContain("frontendWeights");
    expect(ort.created.filter((t) => t === "frontend")).toHaveLength(3);
  });

  it("shares one model load across concurrent transcribes of the same language", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    const [a, b] = await Promise.all([engine.transcribe(testWav()), engine.transcribe(testWav())]);
    expect(a.text).toBe("hello world");
    expect(b.text).toBe("hello world");
    expect(ort.created.filter((t) => t === "frontend")).toHaveLength(1);
  });

  it("dispose releases residents; the next transcribe re-loads", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    await engine.transcribe(testWav());
    engine.dispose();
    expect(ort.released).toContain("decoderKv");
    const result = await engine.transcribe(testWav());
    expect(result.text).toBe("hello world");
  });

  it("warm() preloads a language's slot-1 model (bind only, no decode)", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    await engine.warm("ar");
    expect(ort.created).toContain("frontendWeights");
    // The AR weights blob runs exactly once at bind (load-time, by design —
    // same as the server engine's warm); no decoder step ever ran.
    expect(ort.runs.filter((r) => r.tag === "frontendWeights")).toHaveLength(1);
    expect(ort.runs.filter((r) => r.tag === "decoderKv")).toHaveLength(0);
  });
});

describe("engine contract", () => {
  it("decodes a non-WAV container through AudioContext (browser-only fallback)", async () => {
    const { mod, ort } = await freshModule();
    const buffer = {
      length: 1600,
      sampleRate: 16000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(1600).fill(0.25),
    };
    setGlobal(
      "AudioContext",
      class {
        decodeAudioData = vi.fn(async () => buffer);
        close = vi.fn(async () => undefined);
      },
    );
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    const result = await engine.transcribe(new TextEncoder().encode("fake-webm-opus"));
    expect(result.text).toBe("hello world");
    // The stereo mixdown averaged to the same 0.25 level → same model input.
    const frontend = ort.runs.find((r) => r.tag === "frontend")!;
    expect(frontend.feeds["audio_chunk"]!.dims).toEqual([1, 1600]);
  });

  it("names the WAV contract when no AudioContext exists (node-like runtime)", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    // Ensure no AudioContext shim leaks between tests.
    delete (globalThis as Record<string, unknown>).AudioContext;
    await expect(engine.transcribe(new TextEncoder().encode("mp3 bytes"))).rejects.toThrow(
      /not WAV PCM16.*AudioContext/s,
    );
    expect(ort.runs).toHaveLength(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
    const controller = new AbortController();
    controller.abort();
    await expect(engine.transcribe(testWav(), { signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(ort.created).toHaveLength(0);
  });

  it("rejects languages outside the configured set (falls through to the gateway)", async () => {
    const { mod, ort } = await freshModule();
    const engine = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      languages: ["en"],
    });
    await expect(engine.transcribe(testWav(), { language: "ar" })).rejects.toThrow(
      /"ar" is not enabled/,
    );
    expect(ort.created).toHaveLength(0);
  });

  it("fails loudly with no model origin (throw-origin, never a silent no-op)", async () => {
    const { mod } = await freshModule();
    const engine = mod.createMoonshineSttEngine({ debug: false });
    await expect(engine.transcribe(testWav())).rejects.toThrow(/no ModelOrigin configured/);
  });

  it("forces a known model across languages; unknown ids fall back to slot 1", async () => {
    const { mod, ort } = await freshModule();
    const forced = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      model: "moonshine-batch-base-en",
    });
    await forced.transcribe(testWav(), { language: "ar" }); // forced EN base, not AR
    expect(ort.created).toContain("decoder");
    expect(ort.created).not.toContain("frontend");

    const unknown = mod.createMoonshineSttEngine({
      debug: false,
      modelOrigin: fakeOrigin(),
      model: "whisper-large",
    });
    await unknown.transcribe(testWav());
    expect(ort.created).toContain("frontend");
  });
});

describe("stt-lab telemetry", () => {
  it("emits one flat debug line per transcribe (model, rtf, tokens, flags)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { mod } = await freshModule({ streamingTokens: [12, 12, 12, 12, 13, 2] });
      const engine = mod.createMoonshineSttEngine({ debug: true, modelOrigin: fakeOrigin() });
      const result = await engine.transcribe(testWav());
      expect(result.text).toBe("hello hello hello hello world");

      const line = log.mock.calls.map((c) => c.join(" ")).find((s) => s.includes("stt") || s.includes("[moonshine] model="))!;
      expect(line).toContain("model=moonshine-streaming-tiny-en");
      expect(line).toContain("lang=en");
      expect(line).toMatch(/rtf=\d/);
      expect(line).toContain("tokens=5");
      expect(line).toMatch(/mean_p=\d\.\d{3}/);
      expect(line).toMatch(/silence_halluc=(yes|no)/);
      // "hello" is 4/5 tokens ⇒ the repetition-loop flag fires.
      expect(line).toContain("repeat_loop=yes");
      expect(line).toContain("diacritics=stripped");
    } finally {
      log.mockRestore();
    }
  });

  it("is silent when debug is off", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { mod } = await freshModule();
      const engine = mod.createMoonshineSttEngine({ debug: false, modelOrigin: fakeOrigin() });
      await engine.transcribe(testWav());
      // The ort module-load probe is DELIBERATELY always-logged; everything
      // dbg-gated (stt-lab line, loaded/LRU/gate notes) must be absent.
      const lines = log.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes("rtf="))).toBe(false);
      expect(lines.some((l) => l.includes("[moonshine-browser] loaded"))).toBe(false);
      expect(lines.some((l) => l.includes("confidence gate"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
