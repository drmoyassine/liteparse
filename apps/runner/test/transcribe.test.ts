import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { TranscribeHttpError, type SttService, type SttServiceResult } from "../src/stt-service.js";
import type { ParsedDocument } from "@drmoyassine/liteparse";
import type { ParseService } from "../src/service.js";

/** Full-app /transcribe tests with a spying fake STT service (the escalation
 *  walk itself is covered by stt-service.test.ts; here it's the HTTP ladder). */

const OK: SttServiceResult = {
  text: "hello world",
  language: "en",
  engine: "moonshine-streaming-tiny-en",
  confidence: 0.91,
  warnings: [],
};

function buildApp(over: { sttService?: SttService; sttMaxBytes?: number; maxConcurrency?: number } = {}) {
  const sttService =
    over.sttService ??
    ({ transcribe: vi.fn(async () => ({ ...OK })) } as unknown as SttService);
  const parseService = vi.fn(
    async () => ({ text: "doc", warnings: [], pages: [] }) as unknown as ParsedDocument,
  ) as unknown as ParseService;
  const app = createApp({
    apiKey: "test-key-123",
    version: "0.0.0-test",
    service: parseService,
    sttService,
    sttMaxBytes: over.sttMaxBytes ?? 25 * 1024 * 1024,
    sttMaxTotalMs: 5_000,
    maxConcurrency: over.maxConcurrency ?? 2,
    ocrReady: () => true,
    sttReady: () => true,
    startedAt: Date.now(),
  });
  return { app, sttService: (sttService as unknown as { transcribe: ReturnType<typeof vi.fn> }).transcribe };
}

const KEY = { "x-api-key": "test-key-123", "content-type": "application/json" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const WAV_B64 = b64("RIFF____WAVEfmt _data"); // any bytes — the fake service does the parsing

describe("POST /transcribe — auth + method", () => {
  it("401 on missing or wrong key", async () => {
    const { app } = buildApp();
    const missing = await app.request("/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: WAV_B64 }),
    });
    expect(missing.status).toBe(401);
    const wrong = await app.request("/transcribe", {
      method: "POST",
      headers: { ...KEY, "x-api-key": "wrong" },
      body: JSON.stringify({ data: WAV_B64 }),
    });
    expect(wrong.status).toBe(401);
  });

  it("405 on GET /transcribe", async () => {
    const { app } = buildApp();
    expect((await app.request("/transcribe", { headers: KEY })).status).toBe(405);
  });
});

describe("POST /transcribe — validation ladder", () => {
  it("400 on non-JSON body", async () => {
    const { app } = buildApp();
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: { ...KEY, "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing data / bad base64 / empty bytes", async () => {
    const { app } = buildApp();
    for (const [body, match] of [
      [{ filename: "a.wav" }, /data/],
      [{ data: "!!!!" }, /base64/],
    ] as const) {
      const res = await app.request("/transcribe", { method: "POST", headers: KEY, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(match);
    }
  });

  it("400 on a malformed options object", async () => {
    const { app } = buildApp();
    for (const options of [
      { language: "fr" },
      { keepDiacritics: "yes" },
      { stt: { endpoint: "https://x", model: "m" } }, // apiKey missing
      { stt: "https://x" },
    ]) {
      const res = await app.request("/transcribe", {
        method: "POST",
        headers: KEY,
        body: JSON.stringify({ data: WAV_B64, options }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^options\./);
    }
  });

  it("413 when the decoded audio exceeds sttMaxBytes", async () => {
    const { app } = buildApp({ sttMaxBytes: 4 });
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: b64("way more than four bytes of audio") }),
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /transcribe — contract", () => {
  it("returns exactly the transcribe response keys", async () => {
    const { app } = buildApp();
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: WAV_B64, filename: "note.wav", options: { language: "en" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["confidence", "duration_ms", "engine", "language", "text", "warnings"].sort(),
    );
    expect(body.text).toBe("hello world");
    expect(body.engine).toBe("moonshine-streaming-tiny-en");
    expect(body.confidence).toBe(0.91);
    expect(typeof body.duration_ms).toBe("number");
  });

  it("passes filename + options through to the service", async () => {
    const { app, sttService } = buildApp();
    await app.request("/transcribe", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({
        data: WAV_B64,
        filename: "note.wav",
        options: { language: "ar", keepDiacritics: true },
      }),
    });
    expect(sttService).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "note.wav",
      { language: "ar", keepDiacritics: true },
      expect.any(AbortSignal),
    );
  });

  it("never echoes the caller's gateway apiKey", async () => {
    const secret = "sk-super-secret-stt-key";
    const { app } = buildApp({
      sttService: {
        transcribe: vi.fn(async () => {
          // Worst realistic case: an upstream error string quoting the
          // Authorization header the gateway constructed from the caller's key.
          throw new TranscribeHttpError(503, "gateway rejected Authorization: Bearer sk-super-secret-stt-key");
        }),
      } as unknown as SttService,
    });
    const res = await app.request("/transcribe", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({
        data: WAV_B64,
        options: { stt: { endpoint: "https://gw.example/v1", apiKey: secret, model: "m" } },
      }),
    });
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("Bearer ***");
    expect(res.status).toBe(503);
  });
});

describe("POST /transcribe — failure mapping", () => {
  it("422 when the service rejects undecodable audio", async () => {
    const { app } = buildApp({
      sttService: {
        transcribe: vi.fn(async () => {
          throw new TranscribeHttpError(422, "audio is not WAV PCM16 (not_wav) — decode client-side");
        }),
      } as unknown as SttService,
    });
    const res = await app.request("/transcribe", { method: "POST", headers: KEY, body: JSON.stringify({ data: WAV_B64 }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/WAV PCM16/);
  });

  it("500 with an honest, Bearer-redacted error on unexpected failure", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { app } = buildApp({
        sttService: {
          transcribe: vi.fn(async () => {
            throw new Error("decode exploded after Bearer abc123.def");
          }),
        } as unknown as SttService,
      });
      const res = await app.request("/transcribe", { method: "POST", headers: KEY, body: JSON.stringify({ data: WAV_B64 }) });
      expect(res.status).toBe(500);
      const err = ((await res.json()) as { error: string }).error;
      expect(err).toMatch(/decode exploded/);
      expect(err).not.toContain("abc123.def");
      expect(err).toContain("Bearer ***");
    } finally {
      log.mockRestore();
    }
  });

  it("503 + Retry-After when the shared concurrency slots are full — /parse and /transcribe share one budget", async () => {
    let releaseFirst!: () => void;
    const holding = {
      transcribe: vi.fn(
        () =>
          new Promise<SttServiceResult>((resolve) => {
            releaseFirst = () => resolve({ ...OK });
          }),
      ),
    } as unknown as SttService;
    const { app } = buildApp({ sttService: holding, maxConcurrency: 1 });

    const first = app.request("/transcribe", { method: "POST", headers: KEY, body: JSON.stringify({ data: WAV_B64 }) });
    await new Promise((r) => setTimeout(r, 20)); // let the first acquire its slot

    const second = await app.request("/transcribe", { method: "POST", headers: KEY, body: JSON.stringify({ data: WAV_B64 }) });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBeTruthy();

    // The semaphore is SHARED: a busy /transcribe must also 503 a /parse.
    const parseWhileBusy = await app.request("/parse", { method: "POST", headers: KEY, body: JSON.stringify({ data: b64("doc") }) });
    expect(parseWhileBusy.status).toBe(503);

    releaseFirst();
    expect((await first).status).toBe(200);
  });
});

describe("GET /health", () => {
  it("reports the stt flag", async () => {
    const { app } = buildApp();
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.stt).toBe("ready");
  });

  it("reports stt unavailable before the warm completes", async () => {
    const app = createApp({
      apiKey: "k",
      version: "v",
      service: vi.fn() as unknown as ParseService,
      sttService: { transcribe: vi.fn() } as unknown as SttService,
      ocrReady: () => true,
      sttReady: () => false,
    });
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.stt).toBe("unavailable");
  });
});
