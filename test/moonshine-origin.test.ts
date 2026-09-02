import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOONSHINE_ARTIFACT_VERSION,
  MOONSHINE_SIDECAR_VERSION,
  createMoonshineModelOrigin,
  moonshineDescriptor,
  toMoonshineUrl,
} from "../src/engines/moonshine/model-origin-hf.js";
import { MOONSHINE_MODELS } from "../src/engines/moonshine/shared/models.js";

/**
 * The Moonshine browser origin: id→URL mapping (HF for binaries, SAME-ORIGIN
 * for the decode-critical JSON sidecars), the version split, and the loud
 * 30 s timeout — the engines/rapidocr origin's policy applied to the STT set.
 */

// The sidecar branch reads self.location — node has no self.
const ORIGIN = "https://app.example";
(globalThis as { self?: unknown }).self = { location: { origin: ORIGIN } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("moonshineDescriptor", () => {
  it("keys binaries under the artifact version and sidecars under their own", () => {
    const en = MOONSHINE_MODELS["moonshine-streaming-tiny-en"]!;
    expect(moonshineDescriptor(en, "frontend")).toEqual({
      id: "moonshine-streaming-tiny-en/frontend",
      version: MOONSHINE_ARTIFACT_VERSION,
    });
    expect(moonshineDescriptor(en, "tokenizer").version).toBe(MOONSHINE_SIDECAR_VERSION);
    expect(moonshineDescriptor(en, "streamingConfig").version).toBe(MOONSHINE_SIDECAR_VERSION);
    // Two constants = the dict-precedent split: a corrected sidecar re-fetches
    // (bump SIDECAR alone) without re-downloading ~112 MB of binaries.
    expect(MOONSHINE_ARTIFACT_VERSION).toBeTruthy();
    expect(MOONSHINE_SIDECAR_VERSION).toBeTruthy();
  });
});

describe("toMoonshineUrl", () => {
  it("maps every binary role of every model to its source URL", () => {
    for (const desc of Object.values(MOONSHINE_MODELS)) {
      for (const [role, f] of Object.entries(desc.files)) {
        if (role === "tokenizer" || role === "streamingConfig") continue;
        // Every model resolves from its HF repo (the per-file url override
        // seam exists but is unused since the AR streaming set moved to the
        // mirror — f.url is undefined for every descriptor today).
        expect(toMoonshineUrl(moonshineDescriptor(desc, role))).toBe(
          f.url ?? `https://huggingface.co/${desc.repo}/resolve/main/${f.repoPath}`,
        );
      }
    }
  });

  it("routes the AR streaming binaries to the HF mirror (CORS-open)", () => {
    const ar = MOONSHINE_MODELS["moonshine-streaming-tiny-ar"]!;
    // The official CDN (download.moonshine.ai) serves no CORS headers, so the
    // graphs load from our byte-identical mirror instead — which is what makes
    // the streaming id usable as the BROWSER default too.
    const M = "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/";
    expect(toMoonshineUrl(moonshineDescriptor(ar, "frontend"))).toBe(`${M}frontend.model.ort`);
    expect(toMoonshineUrl(moonshineDescriptor(ar, "frontendWeights"))).toBe(
      `${M}frontend.weights.ort`,
    );
    expect(toMoonshineUrl(moonshineDescriptor(ar, "decoderKv"))).toBe(`${M}decoder_kv.ort`);
    // ...while the tokenizer sidecar stays same-origin like every other model.
    expect(toMoonshineUrl(moonshineDescriptor(ar, "tokenizer"))).toBe(
      `${ORIGIN}/models/moonshine/streaming-tiny-ar/tokenizer.json`,
    );
  });

  it("serves tokenizer + streaming-config same-origin (pinned decode tables)", () => {
    const en = MOONSHINE_MODELS["moonshine-streaming-tiny-en"]!;
    const enBatch = MOONSHINE_MODELS["moonshine-batch-base-en"]!;
    expect(toMoonshineUrl(moonshineDescriptor(en, "tokenizer"))).toBe(
      `${ORIGIN}/models/moonshine/streaming-tiny-en/tokenizer.json`,
    );
    expect(toMoonshineUrl(moonshineDescriptor(en, "streamingConfig"))).toBe(
      `${ORIGIN}/models/moonshine/streaming-tiny-en/streaming_config.json`,
    );
    expect(toMoonshineUrl(moonshineDescriptor(enBatch, "tokenizer"))).toBe(
      `${ORIGIN}/models/moonshine/batch-base-en/tokenizer.json`,
    );
  });

  it("rejects unknown ids with the expected shape", () => {
    expect(() => toMoonshineUrl({ id: "whisper-large", version: "1" })).toThrow(/unknown model id/);
    expect(() => toMoonshineUrl({ id: "moonshine-streaming-tiny-en/nosuch", version: "1" })).toThrow(
      /unknown model id/,
    );
  });
});

describe("createMoonshineModelOrigin", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7);

  it("fetches the mapped URL and returns the bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(bytes(64)));
    vi.stubGlobal("fetch", fetchMock);
    const out = await createMoonshineModelOrigin().fetchModel({
      id: "moonshine-batch-base-en/encoder",
      version: "1.0.0",
    });
    expect(out).toHaveLength(64);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model_int8.onnx",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails loudly on a non-2xx (a 404 sidecar names the deployment gap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(
      createMoonshineModelOrigin().fetchModel({
        id: "moonshine-streaming-tiny-en/tokenizer",
        version: "1.0.0",
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("converts a stall into a loud 30s timeout message", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      ),
    );
    const pending = createMoonshineModelOrigin().fetchModel({
      id: "moonshine-streaming-tiny-en/decoderKv",
      version: "1.0.0",
    });
    const assertion = expect(pending).rejects.toThrow(/timed out after 30s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
