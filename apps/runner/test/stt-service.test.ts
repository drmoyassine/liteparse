import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STT_MODEL, ESCALATION_STT_MODEL, type SttResult } from "@drmoyassine/liteparse";
import type { MoonshineServerEngine, MoonshineServerOptions } from "@drmoyassine/liteparse/stt/moonshine-server";
import { createSttService, TranscribeHttpError, type SttServiceDeps } from "../src/stt-service.js";

/**
 * Escalation-walk unit tests: the engine factory is faked per model id, the
 * external gateway is exercised through the REAL createServerSttGateway with a
 * stubbed fetch (the gateway's own wire behavior is covered by the root
 * stt-gateway tests). The WAV pre-flight is the real parseWavPcm16.
 */

const SLOT1_EN = DEFAULT_STT_MODEL.en;
const SLOT2_EN = ESCALATION_STT_MODEL.en!;
const SLOT1_AR = DEFAULT_STT_MODEL.ar;

/** Minimal valid mono-16k PCM16 WAV (what the contract asks for). */
function wavBytes(seconds = 0.1): Uint8Array {
  const n = Math.round(seconds * 16000);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  return out;
}

interface FakeEngine extends MoonshineServerEngine {
  transcribe: ReturnType<typeof vi.fn>;
  warm: ReturnType<typeof vi.fn>;
}

function fakeEngine(over: Partial<SttResult> = {}): FakeEngine {
  return {
    name: "fake-moonshine",
    available: true,
    transcribe: vi.fn(async () => ({ text: "hello world", confidence: 0.9, language: "en", ...over })),
    warm: vi.fn(async () => {}),
    dispose: () => {},
  };
}

function rejectedEngine(reason: string): FakeEngine {
  const e = fakeEngine();
  e.transcribe = vi.fn(async () => {
    throw new Error(reason);
  });
  return e;
}

/** Build the service with per-model fake engines; every engine call is recorded. */
function buildService(
  enginesByModel: Partial<Record<string, FakeEngine>>,
  deps: Partial<SttServiceDeps> = {},
) {
  const createEngine = vi.fn(async (opts: MoonshineServerOptions) => {
    // warm() creates the engine WITHOUT a forced model (mirrors the real
    // factory: the slot-1 default resolves per language at transcribe time).
    const engine = enginesByModel[opts.model ?? SLOT1_EN];
    if (!engine) throw new Error(`no fake for model "${opts.model}"`);
    return engine;
  });
  const service = createSttService({ createEngine, ...deps });
  return { service, createEngine };
}

function gatewayFetch(text: string) {
  return vi.fn(async () => new Response(JSON.stringify({ text }), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slot 1 — happy path", () => {
  it("resolves immediately when confidence clears the floor", async () => {
    const { service, createEngine } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "hello world", confidence: 0.9 }),
      [SLOT1_AR]: fakeEngine({ text: "hello world ar", confidence: 0.85, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result).toMatchObject({ text: "hello world", engine: SLOT1_EN, confidence: 0.9, language: "en" });
    expect(result.warnings.some((w) => w.includes("auto: picked en"))).toBe(true);
    expect(createEngine.mock.calls.map((c) => c[0].model)).toEqual([SLOT1_EN, SLOT1_AR]);
  });

  it("defaults to auto: dual-decodes both slot-1 models, threads language + filename", async () => {
    const en = fakeEngine();
    const ar = fakeEngine({ text: "hola", confidence: 0.8, language: "ar" });
    const { service } = buildService({ [SLOT1_EN]: en, [SLOT1_AR]: ar });
    const result = await service.transcribe(wavBytes(), "note.wav", undefined, undefined);
    expect(en.transcribe).toHaveBeenCalledWith(
      wavBytes(), // deterministic fixture → byte-identical
      expect.objectContaining({ language: "en", filename: "note.wav" }),
    );
    expect(ar.transcribe).toHaveBeenCalledWith(
      wavBytes(),
      expect.objectContaining({ language: "ar", filename: "note.wav" }),
    );
    expect(result.language).toBe("en"); // no Arabic script → status-quo default
  });

  it("threads keepDiacritics into the engine options", async () => {
    const engine = fakeEngine({ text: "محمد", confidence: 0.9, language: "ar" });
    const { service, createEngine } = buildService({ [SLOT1_AR]: engine });
    await service.transcribe(wavBytes(), "a.wav", { language: "ar", keepDiacritics: true }, undefined);
    expect(createEngine.mock.calls[0]![0]).toMatchObject({ model: SLOT1_AR, keepDiacritics: true });
  });
});

describe("escalation", () => {
  it("EN under the floor escalates to base-en", async () => {
    const { service, createEngine } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "helo wrld", confidence: 0.3 }),
      [SLOT1_AR]: fakeEngine({ text: "helo wrld ar", confidence: 0.3, language: "ar" }),
      [SLOT2_EN]: fakeEngine({ text: "hello world", confidence: 0.92 }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result.engine).toBe(SLOT2_EN);
    expect(result.confidence).toBe(0.92);
    expect(result.warnings.some((w) => w.includes("winner under floor"))).toBe(true);
    expect(createEngine.mock.calls.map((c) => c[0].model)).toEqual([SLOT1_EN, SLOT1_AR, SLOT2_EN]);
  });

  it("escalates on an empty transcript even at high confidence", async () => {
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "  ", confidence: 0.99 }),
      [SLOT1_AR]: fakeEngine({ text: "hola", confidence: 0.9, language: "ar" }),
      [SLOT2_EN]: fakeEngine({ text: "hello", confidence: 0.9 }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result.engine).toBe(SLOT2_EN);
    expect(result.warnings.some((w) => w.includes("winner under floor"))).toBe(true);
  });

  it("an unavailable slot 1 records a warning and falls through to slot 2", async () => {
    const { service } = buildService({
      [SLOT1_EN]: rejectedEngine("Moonshine model moonshine-streaming-tiny-en incomplete"),
      [SLOT2_EN]: fakeEngine({ text: "hello", confidence: 0.9 }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", { language: "en" }, undefined);
    expect(result.engine).toBe(SLOT2_EN);
    expect(result.warnings.some((w) => w.includes("unavailable"))).toBe(true);
  });

  it("AR skips slot 2 entirely — low confidence goes straight to the gateway", async () => {
    const fetchMock = gatewayFetch("مرحبا بالعالم");
    vi.stubGlobal("fetch", fetchMock);
    const baseEn = fakeEngine();
    const { service, createEngine } = buildService({
      [SLOT1_AR]: fakeEngine({ text: "مرحبا", confidence: 0.2, language: "ar" }),
      [SLOT2_EN]: baseEn,
    });
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { language: "ar", stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "gpt-4o-transcribe" } },
      undefined,
    );
    expect(result.engine).toBe("stt-gateway");
    expect(result.text).toBe("مرحبا بالعالم");
    expect(result.confidence).toBeNull();
    expect(createEngine.mock.calls.map((c) => c[0].model)).toEqual([SLOT1_AR]); // base-en never ran
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(baseEn.transcribe).not.toHaveBeenCalled();
  });

  it("EN under both floors resolves via the gateway with null confidence", async () => {
    vi.stubGlobal("fetch", gatewayFetch("gateway text"));
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "a", confidence: 0.2 }),
      [SLOT1_AR]: fakeEngine({ text: "hola", confidence: 0.3, language: "ar" }),
      [SLOT2_EN]: fakeEngine({ text: "b", confidence: 0.3 }),
    });
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "m" } },
      undefined,
    );
    expect(result).toMatchObject({ engine: "stt-gateway", text: "gateway text", confidence: null });
    expect(result.warnings).toHaveLength(2); // both floor notes, no best-effort note
  });
});

describe("best-effort + failures", () => {
  it("gateway returning no text falls back to the strongest local attempt", async () => {
    vi.stubGlobal("fetch", gatewayFetch(""));
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "weak", confidence: 0.2 }),
      [SLOT2_EN]: fakeEngine({ text: "stronger guess", confidence: 0.4 }),
    });
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "m" } },
      undefined,
    );
    expect(result.engine).toBe(SLOT2_EN);
    expect(result.text).toBe("stronger guess");
    expect(result.warnings.some((w) => w.includes("best-effort"))).toBe(true);
  });

  it("AR without a gateway returns best-effort with an honest warning", async () => {
    const { service } = buildService({
      [SLOT1_AR]: fakeEngine({ text: "مرحبا", confidence: 0.3, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", { language: "ar" }, undefined);
    expect(result).toMatchObject({ engine: SLOT1_AR, text: "مرحبا", confidence: 0.3 });
    expect(result.warnings.some((w) => w.includes("no options.stt gateway"))).toBe(true);
  });

  it("503 when nothing is runnable and no gateway is configured", async () => {
    const { service } = buildService({});
    await expect(service.transcribe(wavBytes(), "a.wav", {}, undefined)).rejects.toMatchObject({
      name: "TranscribeHttpError",
      status: 503,
    });
  });

  it("gateway-only mode still transcribes when no local model exists", async () => {
    vi.stubGlobal("fetch", gatewayFetch("from the cloud"));
    const { service } = buildService({});
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "m" } },
      undefined,
    );
    expect(result).toMatchObject({ engine: "stt-gateway", text: "from the cloud" });
    expect(result.warnings.some((w) => w.includes("unavailable"))).toBe(true);
  });

  it("a gateway failure is a warning, not a service failure", async () => {
    // The real gateway NEVER throws on transport errors (its contract resolves
    // {text:""}), so a crashing fetch surfaces here as "returned no text" —
    // the service's catch is only reachable on caller-initiated aborts.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "local guess", confidence: 0.4 }),
    });
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "m" } },
      undefined,
    );
    expect(result.text).toBe("local guess");
    expect(result.warnings.some((w) => w.includes("stt-gateway"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("best-effort"))).toBe(true);
  });
});

describe("WAV contract (422)", () => {
  it("rejects non-WAV bytes before any model loads, naming the contract", async () => {
    const { service, createEngine } = buildService({ [SLOT1_EN]: fakeEngine() });
    const garbage = new TextEncoder().encode("ID3 minus the rest of the mp3");
    await expect(service.transcribe(garbage, "a.mp3", {}, undefined)).rejects.toMatchObject({
      name: "TranscribeHttpError",
      status: 422,
      message: expect.stringMatching(/WAV PCM16/),
    });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("rejects a truncated WAV with a 422 naming the failure (TASK-221: ffmpeg transcode leg)", async () => {
    const { service } = buildService({ [SLOT1_EN]: fakeEngine() });
    const truncated = wavBytes().slice(0, 30);
    await expect(service.transcribe(truncated, "a.wav", {}, undefined)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/truncated|not_wav|missing|transcode failed|invalid data/i),
    });
  });
});

describe("abort handling", () => {
  it("propagates a pre-aborted signal instead of warning through it", async () => {
    const { service } = buildService({ [SLOT1_EN]: fakeEngine() });
    const signal = AbortSignal.abort();
    await expect(service.transcribe(wavBytes(), "a.wav", {}, signal)).rejects.toThrow(/aborted/);
  });

  it("aborts between slots instead of continuing the walk", async () => {
    const ctrl = new AbortController();
    const engine = fakeEngine({ text: "?", confidence: 0.1 });
    engine.transcribe = vi.fn(async () => {
      ctrl.abort(new Error("deadline exceeded")); // deadline fires mid-slot-1
      return { text: "?", confidence: 0.1, language: "en" } as SttResult;
    });
    const slot2 = fakeEngine();
    const { service } = buildService({ [SLOT1_EN]: engine, [SLOT2_EN]: slot2 });
    await expect(service.transcribe(wavBytes(), "a.wav", {}, ctrl.signal)).rejects.toThrow(/aborted/);
    expect(slot2.transcribe).not.toHaveBeenCalled();
  });
});

describe('language:"auto" — the default (mixed en/ar voice notes)', () => {
  it("picks AR on Arabic script even when the EN decode is confident", async () => {
    // 2026-10-22 production case, generalized: tiny-en's vocab cannot produce
    // Arabic script, so its presence is positive evidence the clip is Arabic.
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "so i have a question about the university", confidence: 0.9 }),
      [SLOT1_AR]: fakeEngine({ text: "عندي سؤال عن الجامعة", confidence: 0.8, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result).toMatchObject({
      language: "ar",
      engine: SLOT1_AR,
      text: "عندي سؤال عن الجامعة",
      confidence: 0.8,
    });
    expect(result.warnings.some((w) => w.includes("Arabic script"))).toBe(true);
  });

  it("picks AR when the EN decode is a repetition loop and AR is clean Latin", async () => {
    const loop = Array(10).fill("so i have a question").join(" "); // 50 words, 5 unique
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: loop, confidence: 0.9 }),
      [SLOT1_AR]: fakeEngine({ text: "3andi sou2al 3an el jam3a", confidence: 0.7, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result).toMatchObject({ language: "ar", engine: SLOT1_AR });
    expect(result.warnings.some((w) => w.includes("repetition loop"))).toBe(true);
  });

  it("picks EN when the AR decode loops without producing Arabic script", async () => {
    const loop = Array(10).fill("salam salam salam").join(" ");
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "hello there how are you doing today", confidence: 0.85 }),
      [SLOT1_AR]: fakeEngine({ text: loop, confidence: 0.9, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result).toMatchObject({ language: "en", engine: SLOT1_EN });
  });

  it("both decodes degenerate: higher confidence wins", async () => {
    const enLoop = Array(10).fill("i have a question about").join(" ");
    const arLoop = Array(10).fill("salam alaikum salam alaikum").join(" ");
    const { service } = buildService({
      [SLOT1_EN]: fakeEngine({ text: enLoop, confidence: 0.4 }),
      [SLOT1_AR]: fakeEngine({ text: arLoop, confidence: 0.75, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", {}, undefined);
    expect(result).toMatchObject({ language: "ar", engine: SLOT1_AR });
    expect(result.warnings.some((w) => w.includes("higher confidence wins"))).toBe(true);
  });

  it("winner under the floor escalates with the CHOSEN language (ar → gateway, slot 2 skipped)", async () => {
    vi.stubGlobal("fetch", gatewayFetch("مرحبا بالعالم"));
    const baseEn = fakeEngine();
    const { service, createEngine } = buildService({
      [SLOT1_EN]: fakeEngine({ text: "what what what", confidence: 0.4 }),
      [SLOT1_AR]: fakeEngine({ text: "شكرا جزيلا على المساعدة", confidence: 0.3, language: "ar" }),
      [SLOT2_EN]: baseEn,
    });
    const result = await service.transcribe(
      wavBytes(),
      "a.wav",
      { stt: { endpoint: "https://gw.example/v1/audio/transcriptions", apiKey: "sk-x", model: "m" } },
      undefined,
    );
    expect(result).toMatchObject({
      language: "ar",
      engine: "stt-gateway",
      text: "مرحبا بالعالم",
      confidence: null,
    });
    expect(createEngine.mock.calls.map((c) => c[0].model)).toEqual([SLOT1_EN, SLOT1_AR]); // slot 2 skipped
    expect(baseEn.transcribe).not.toHaveBeenCalled();
  });

  it("an explicit language never dual-decodes (legacy behavior)", async () => {
    const { service, createEngine } = buildService({
      [SLOT1_AR]: fakeEngine({ text: "مرحبا", confidence: 0.9, language: "ar" }),
    });
    const result = await service.transcribe(wavBytes(), "a.wav", { language: "ar" }, undefined);
    expect(result).toMatchObject({ language: "ar", engine: SLOT1_AR });
    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});

describe("warm", () => {
  it("creates the default engine and warms BOTH slot-1 languages", async () => {
    const engine = fakeEngine();
    const { service } = buildService({ [SLOT1_EN]: engine });
    await service.warm();
    expect(engine.warm).toHaveBeenCalledWith("en");
    expect(engine.warm).toHaveBeenCalledWith("ar");
  });
});
