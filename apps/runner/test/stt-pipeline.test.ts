import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSttService } from "../src/stt-service.js";
import { DEFAULT_STT_MODEL, ESCALATION_STT_MODEL } from "@drmoyassine/liteparse";

/**
 * The REAL STT end-to-end proof: genuine Moonshine artifacts through the
 * escalation service (and the full HTTP surface). Sine-wave input can't assert
 * transcript content — it asserts the WALK: which slots ran, honest confidence,
 * the 422 contract, and the exact response key set.
 *
 * Skipped unless apps/runner/models/moonshine/streaming-tiny-en exists — run
 * `npm run fetch-moonshine-models` first (CI never downloads).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "..", "models", "moonshine");

/** `seconds` of 440 Hz sine as mono-16k PCM16 WAV — the smoke-test stimulus. */
function sineWav(seconds: number, freq = 440): Uint8Array {
  const n = Math.round(seconds * 16000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(0.4 * Math.sin((2 * Math.PI * freq * i) / 16000) * 32767);
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
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
}

describe.skipIf(!existsSync(resolve(MODELS, "streaming-tiny-en")))("STT pipeline (real models)", { timeout: 180_000 }, () => {
  it("runs the AR slot-1 model and reports honest confidence", async () => {
    const service = createSttService({});
    const result = await service.transcribe(sineWav(1.0), "ar-sine.wav", { language: "ar" }, undefined);
    expect(result.language).toBe("ar");
    expect(result.engine).toBe(DEFAULT_STT_MODEL.ar);
    expect(typeof result.text).toBe("string");
    expect(result.confidence).not.toBeNull();
    expect(result.confidence!).toBeGreaterThan(0);
    expect(result.confidence!).toBeLessThanOrEqual(1);
  });

  it("walks EN slots on a non-speech stimulus (sine → no confident transcript)", async () => {
    const service = createSttService({});
    const result = await service.transcribe(sineWav(1.2), "en-sine.wav", { language: "en" }, undefined);
    expect(result.language).toBe("en");
    // Either slot cleared the floor, or we get best-effort from one of them.
    expect([DEFAULT_STT_MODEL.en, ESCALATION_STT_MODEL.en]).toContain(result.engine);
    // Sine never yields a confident transcript without a gateway: the walk
    // always leaves a trace of WHY it returned what it returned.
    if (result.text.trim() === "") expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("422s non-WAV bytes through the full app, naming the contract", async () => {
    const { createApp } = await import("../src/app.js");
    const { createLiteparseService } = await import("../src/service.js");
    const app = createApp({
      apiKey: "k-test",
      version: "0.0.0-test",
      service: createLiteparseService(),
      sttService: createSttService({}),
      sttMaxBytes: 25 * 1024 * 1024,
      sttMaxTotalMs: 60_000,
      maxConcurrency: 2,
      ocrReady: () => true,
      sttReady: () => true,
      startedAt: Date.now(),
    });
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: { "x-api-key": "k-test", "content-type": "application/json" },
      body: JSON.stringify({ data: Buffer.from("ID3 fake mp3 bytes").toString("base64"), filename: "a.mp3" }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/WAV PCM16/);
  });

  it("returns the exact response key set through POST /transcribe", async () => {
    const { createApp } = await import("../src/app.js");
    const { createLiteparseService } = await import("../src/service.js");
    const app = createApp({
      apiKey: "k-test",
      version: "0.0.0-test",
      service: createLiteparseService(),
      sttService: createSttService({}),
      sttMaxBytes: 25 * 1024 * 1024,
      sttMaxTotalMs: 60_000,
      maxConcurrency: 2,
      ocrReady: () => true,
      sttReady: () => true,
      startedAt: Date.now(),
    });
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: { "x-api-key": "k-test", "content-type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from(sineWav(0.5)).toString("base64"),
        filename: "en-sine.wav",
        options: { language: "en" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["confidence", "duration_ms", "engine", "language", "text", "warnings"].sort(),
    );
  });
});
