import { describe, expect, it, vi } from "vitest";
import { createSttGatewayEngine, sttEngineAsOcr } from "../src/stt/engine.js";
import type { SttEngine, SttGateway } from "../src/types.js";

/**
 * Tests for src/stt/engine.ts — the audio-as-page adapters. An audio document
 * flows through executeRoute's page-image machinery exactly like an image: the
 * clip bytes are the single page, `recognize` forwards to `transcribe`, and the
 * winning strategy's output is tagged source "stt" (asserted in
 * ocr-worker.test.ts / pipeline.stt.test.ts).
 */

const CLIP = new Uint8Array([1, 2, 3, 4]);

function fakeGateway(
  text: string,
  opts: { throws?: boolean } = {},
): SttGateway & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    transcribe: vi.fn(async () => {
      if (opts.throws) throw new Error("gateway boom");
      return { text, confidence: 0.7 };
    }),
  };
}

function fakeSttEngine(
  text: string,
  opts: { available?: boolean; throws?: boolean; name?: string } = {},
): SttEngine & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    name: opts.name ?? "moonshine-test",
    available: opts.available ?? true,
    transcribe: vi.fn(async () => {
      if (opts.throws) throw new Error("engine boom");
      return { text, confidence: 0.9, language: "en" };
    }),
  };
}

describe("createSttGatewayEngine", () => {
  it("wraps a gateway as an available OcrEngine named stt-gateway", () => {
    const engine = createSttGatewayEngine(fakeGateway("hi"));
    expect(engine.name).toBe("stt-gateway");
    expect(engine.available).toBe(true);
  });

  it("forwards the clip bytes + signal + language, and trims/confidence-maps the result", async () => {
    const gw = fakeGateway("  hello  ");
    const engine = createSttGatewayEngine(gw, "ar");
    const signal = new AbortController().signal;
    const out = await engine.recognize(CLIP, { pageIndex: 0, totalPages: 1, signal });

    expect(out).toEqual({ text: "hello", confidence: 0.7 });
    expect(gw.transcribe).toHaveBeenCalledWith(CLIP, { signal, language: "ar" });
  });

  it("maps a gateway's {text:''} under-yield straight through (cascade falls through)", async () => {
    const engine = createSttGatewayEngine(fakeGateway(""));
    const out = await engine.recognize(CLIP, { pageIndex: 0, totalPages: 1 });
    expect(out.text).toBe("");
  });

  it("propagates a throwing gateway — executeRoute turns that into a warning", async () => {
    const engine = createSttGatewayEngine(fakeGateway("x", { throws: true }));
    await expect(
      engine.recognize(CLIP, { pageIndex: 0, totalPages: 1 }),
    ).rejects.toThrow("gateway boom");
  });
});

describe("sttEngineAsOcr", () => {
  it("exposes the wrapped engine's name and availability", () => {
    const up = sttEngineAsOcr(fakeSttEngine("hi", { name: "moonshine" }));
    expect(up.name).toBe("moonshine");
    expect(up.available).toBe(true);

    const down = sttEngineAsOcr(fakeSttEngine("hi", { available: false }));
    expect(down.available).toBe(false);
  });

  it("forwards bytes + signal + language and trims the result", async () => {
    const stt = fakeSttEngine("  notes  ");
    const engine = sttEngineAsOcr(stt, "en");
    const signal = new AbortController().signal;
    const out = await engine.recognize(CLIP, { pageIndex: 0, totalPages: 1, signal });

    expect(out).toEqual({ text: "notes", confidence: 0.9 });
    expect(stt.transcribe).toHaveBeenCalledWith(CLIP, { signal, language: "en" });
  });

  it("propagates a throwing engine — the per-page catch in executeRoute handles it", async () => {
    const engine = sttEngineAsOcr(fakeSttEngine("x", { throws: true }));
    await expect(
      engine.recognize(CLIP, { pageIndex: 0, totalPages: 1 }),
    ).rejects.toThrow("engine boom");
  });
});
