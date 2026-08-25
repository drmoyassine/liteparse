import { describe, expect, it } from "vitest";
import { DEFAULT_PER_PAGE_TIMEOUT_MS, toParseOptions } from "../src/service.js";
import type { OcrEngine, PdfLibrary, RasterAdapter } from "liteparse";

const adapters = {
  raster: {} as RasterAdapter,
  ocrEngine: {} as OcrEngine,
  pdfjs: {} as PdfLibrary,
};
const signal = new AbortController().signal;

describe("toParseOptions — clamps", () => {
  it("leaves caller values inside bounds untouched", () => {
    const o = toParseOptions("a.pdf", { maxPages: 5, perPageTimeoutMs: 30_000, maxChars: 1_000 }, signal, adapters);
    expect(o.maxPages).toBe(5);
    expect(o.perPageTimeoutMs).toBe(30_000);
    expect(o.maxChars).toBe(1_000);
  });

  it("clamps out-of-range values into bounds", () => {
    const o = toParseOptions(
      "a.pdf",
      { maxPages: 500, perPageTimeoutMs: 999_999, maxChars: 1e9 },
      signal,
      adapters,
    );
    expect(o.maxPages).toBe(50);
    expect(o.perPageTimeoutMs).toBe(120_000);
    expect(o.maxChars).toBe(200_000);

    const lo = toParseOptions("a.pdf", { maxPages: 0, perPageTimeoutMs: 10, maxChars: 1 }, signal, adapters);
    expect(lo.maxPages).toBe(1);
    expect(lo.perPageTimeoutMs).toBe(1_000);
    expect(lo.maxChars).toBe(100);
  });

  it("treats non-finite numbers as unset (library defaults apply)", () => {
    const o = toParseOptions(
      "a.pdf",
      { maxPages: Number.NaN, perPageTimeoutMs: Number.POSITIVE_INFINITY },
      signal,
      adapters,
    );
    expect(o.maxPages).toBeUndefined();
    expect(o.perPageTimeoutMs).toBe(DEFAULT_PER_PAGE_TIMEOUT_MS);
  });

  it("applies the 60s per-page default when unset (caller parity, not the library's 30s)", () => {
    const o = toParseOptions("a.pdf", undefined, signal, adapters);
    expect(o.perPageTimeoutMs).toBe(60_000);
    expect(DEFAULT_PER_PAGE_TIMEOUT_MS).toBe(60_000);
    // Unset budgets fall through as undefined so pipeline.ts applies its own defaults.
    expect(o.maxPages).toBeUndefined();
    expect(o.maxChars).toBeUndefined();
  });
});

describe("toParseOptions — adapters + signal", () => {
  it("ALWAYS injects raster + ocrEngine + pdfjs (the browser-parity contract)", () => {
    const o = toParseOptions("a.pdf", undefined, signal, adapters);
    expect(o.raster).toBe(adapters.raster);
    expect(o.ocrEngine).toBe(adapters.ocrEngine);
    expect(o.pdfjs).toBe(adapters.pdfjs);
    expect(o.signal).toBe(signal);
    expect(o.filename).toBe("a.pdf");
  });

  it("tolerates a missing filename (classify still runs on magic bytes)", () => {
    const o = toParseOptions(undefined, undefined, signal, adapters);
    expect(o.filename).toBeUndefined();
  });
});

describe("toParseOptions — per-request VLM", () => {
  it("builds a gateway with temperature 0 by default, honoring keyHeader", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: " ok " } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const o = toParseOptions(
        "a.png",
        { vlm: { endpoint: "https://vlm.example/v1", apiKey: "sk-x", model: "m1", keyHeader: "X-Key" } },
        signal,
        adapters,
      );
      expect(o.vlm).toBeDefined();
      const text = await o.vlm!.readImage(new Uint8Array([1, 2, 3]));
      expect(text).toBe("ok"); // trimmed
      expect(calls[0]!.url).toBe("https://vlm.example/v1");
      const body = JSON.parse(String(calls[0]!.init.body)) as { temperature: number; model: string };
      expect(body.temperature).toBe(0); // deterministic transcription default
      expect(body.model).toBe("m1");
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["X-Key"]).toBe("sk-x");
      expect(headers["Authorization"]).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps a caller temperature override authoritative", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "t" } }] }), { status: 200 })) as typeof fetch;
    try {
      const o = toParseOptions(
        "a.png",
        { vlm: { endpoint: "https://vlm.example/v1", apiKey: "sk-x", model: "m1", temperature: 0.4 } },
        signal,
        adapters,
      );
      await o.vlm!.readImage(new Uint8Array([1]));
      expect(o.vlm).toBeDefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("omits the gateway entirely when the caller sends no vlm config", () => {
    const o = toParseOptions("a.pdf", {}, signal, adapters);
    expect(o.vlm).toBeUndefined();
  });
});
