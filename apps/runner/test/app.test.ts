import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ParseService } from "../src/service.js";
import type { SttService } from "../src/stt-service.js";
import type { ParsedDocument } from "@drmoyassine/liteparse";

/** A deterministic stand-in ParsedDocument. */
function fakeDoc(over: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    text: "hello fixture",
    source: "ocr",
    pages: [{}, {}] as ParsedDocument["pages"],
    warnings: [],
    kind: "pdf",
    meta: {
      pagesProcessed: 2,
      totalPages: 2,
      nativePages: 0,
      ocrPages: 2,
      vlmPages: 0,
      sttPages: 0,
      truncated: false,
      chars: 13,
    },
    ...over,
  };
}

/** Build the app with a spying fake service. */
function buildApp(over: { service?: ParseService; maxBytes?: number; maxConcurrency?: number } = {}) {
  const service =
    over.service ??
    (vi.fn(async () => fakeDoc()) as unknown as ParseService);
  const app = createApp({
    apiKey: "test-key-123",
    version: "0.0.0-test",
    service,
    sttService: vi.fn() as unknown as SttService,
    maxBytes: over.maxBytes ?? 20 * 1024 * 1024,
    maxTotalMs: 5_000,
    maxConcurrency: over.maxConcurrency ?? 2,
    ocrReady: () => true,
    sttReady: () => true,
    startedAt: Date.now(),
  });
  return { app, service: service as ReturnType<typeof vi.fn> };
}

const KEY = { "x-api-key": "test-key-123", "content-type": "application/json" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("GET /health", () => {
  it("is unauthenticated and reports the contract shape", async () => {
    const { app } = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBe("0.0.0-test");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.ocr).toBe("ready");
    expect(body.stt).toBe("ready");
  });

  it("reports ocr unavailable when the engine has not warmed", async () => {
    const app = createApp({
      apiKey: "k",
      version: "v",
      service: vi.fn() as unknown as ParseService,
      sttService: vi.fn() as unknown as SttService,
      ocrReady: () => false,
      sttReady: () => true,
    });
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.ocr).toBe("unavailable");
  });
});

describe("POST /parse — auth", () => {
  it("401 on missing key", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: b64("x"), filename: "a.txt" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it("401 on wrong key", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: { ...KEY, "x-api-key": "wrong" },
      body: JSON.stringify({ data: b64("x") }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /parse — validation", () => {
  it("405 on GET /parse", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", { headers: KEY });
    expect(res.status).toBe(405);
  });

  it("400 on non-JSON body", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: { ...KEY, "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing data", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ filename: "a.pdf" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/data/);
  });

  it("400 on invalid base64", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: "!!!!not-base64!!!!" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/base64/);
  });

  it("413 when the decoded document exceeds maxBytes", async () => {
    const { app } = buildApp({ maxBytes: 4 });
    const res = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: b64("way more than four bytes") }),
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /parse — contract", () => {
  it("returns exactly the parse-document response keys", async () => {
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: b64("doc"), filename: "a.pdf" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["duration_ms", "kind", "page_count", "source", "text", "warnings"].sort(),
    );
    expect(body.text).toBe("hello fixture");
    expect(body.page_count).toBe(2); // pages.length, matching the edge function
    expect(typeof body.duration_ms).toBe("number");
  });

  it("never echoes the caller's VLM apiKey", async () => {
    const secret = "sk-super-secret-vlm-key";
    const { app } = buildApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({
        data: b64("doc"),
        options: { vlm: { endpoint: "https://vlm.example/v1", apiKey: secret, model: "m" } },
      }),
    });
    const text = await res.text();
    expect(text).not.toContain(secret);
  });

  it("503 + Retry-After when the concurrency slots are full", async () => {
    let releaseFirst!: () => void;
    const service = vi.fn(
      () =>
        new Promise<ParsedDocument>((resolve) => {
          releaseFirst = () => resolve(fakeDoc());
        }),
    ) as unknown as ParseService;
    const { app } = buildApp({ service, maxConcurrency: 1 });

    const first = app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: b64("doc") }),
    });
    await new Promise((r) => setTimeout(r, 20)); // let the first acquire its slot

    const second = await app.request("/parse", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({ data: b64("doc2") }),
    });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBeTruthy();

    releaseFirst();
    expect((await first).status).toBe(200);
  });

  it("500 with an honest error when the service throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { app } = buildApp({
        service: vi.fn(async () => {
          throw new Error("engine exploded");
        }) as unknown as ParseService,
      });
      const res = await app.request("/parse", {
        method: "POST",
        headers: KEY,
        body: JSON.stringify({ data: b64("doc") }),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toMatch(/engine exploded/);
    } finally {
      log.mockRestore();
    }
  });
});

describe("404 + method shape", () => {
  it("404s unknown paths with the error envelope", async () => {
    const { app } = buildApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/not found/);
  });
});
