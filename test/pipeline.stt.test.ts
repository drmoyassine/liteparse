import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "../src/pipeline.js";
import type { SttEngine, SttGateway } from "../src/types.js";

/**
 * parseDocument on AUDIO documents (Track 3 v0): classify (sniff → "audio") →
 * route (moonshine? → stt-gateway) → execute (the clip bytes are the single
 * "page"). Mirrors pipeline.test.ts's route-actually-taken style with injected
 * fakes — no network, no models.
 */

// RIFF<size>WAVE — the smallest header sniff needs to call this a WAV.
const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);

function fakeGateway(text: string): SttGateway & { transcribe: ReturnType<typeof vi.fn> } {
  return { transcribe: vi.fn(async () => ({ text, language: "en" })) };
}

function fakeSttEngine(
  text: string,
  opts: { available?: boolean } = {},
): SttEngine & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    name: "moonshine-fake",
    available: opts.available ?? true,
    transcribe: vi.fn(async () => ({ text, confidence: text ? 0.9 : 0.1 })),
  };
}

describe("parseDocument — audio documents (external gateway)", () => {
  it("classifies WAV as audio, transcribes via the gateway, tags source stt", async () => {
    const gw = fakeGateway("meeting notes here");
    const doc = await parseDocument(WAV, { stt: gw, filename: "note.wav" });

    expect(doc.kind).toBe("audio");
    expect(doc.text).toBe("meeting notes here");
    expect(doc.source).toBe("stt");
    expect(doc.pages).toEqual([{ index: 0, text: "meeting notes here", source: "stt" }]);
    expect(doc.meta.sttPages).toBe(1);
    expect(doc.meta.pagesProcessed).toBe(1);
    expect(gw.transcribe).toHaveBeenCalledOnce();
  });

  it("classifies by extension when the magic is absent (recorded webm)", async () => {
    const gw = fakeGateway("hello");
    const doc = await parseDocument(new Uint8Array([1, 2, 3, 4, 5]), {
      stt: gw,
      filename: "voice-note.webm",
    });
    expect(doc.kind).toBe("audio");
    expect(doc.text).toBe("hello");
  });

  it("forwards the language hint to the gateway", async () => {
    const gw = fakeGateway("مرحبا");
    await parseDocument(WAV, { stt: gw, sttLanguage: "ar", filename: "note.wav" });
    expect(gw.transcribe).toHaveBeenCalledWith(
      WAV,
      expect.objectContaining({ language: "ar" }),
    );
  });

  it("degrades to empty + honest warning when no STT is wired at all", async () => {
    const doc = await parseDocument(WAV, { filename: "note.wav" });
    expect(doc.text).toBe("");
    expect(doc.source).toBe("none");
    expect(doc.meta.sttPages).toBe(0);
    // The route still emitted the external leg, so executeRoute explains WHY
    // audio went untranscribed instead of returning mojibake text.
    expect(doc.warnings.some((w) => w.includes("stt-gateway") && w.includes("not wired"))).toBe(
      true,
    );
  });

  it("resolves {text:''} (never throws) when the gateway under-yields", async () => {
    const gw = fakeGateway("");
    const doc = await parseDocument(WAV, { stt: gw, filename: "note.wav" });
    expect(doc.text).toBe("");
    expect(doc.source).toBe("none");
    expect(doc.warnings.some((w) => w.includes("0 non-ws"))).toBe(true);
  });
});

describe("parseDocument — audio cascade (local engine → external gateway)", () => {
  it("prefers the injected local engine and never calls the gateway on a win", async () => {
    const stt = fakeSttEngine("local transcript wins");
    const gw = fakeGateway("external transcript");
    const doc = await parseDocument(WAV, { stt: gw, sttEngine: stt, filename: "note.wav" });

    expect(doc.text).toBe("local transcript wins");
    expect(doc.source).toBe("stt");
    expect(stt.transcribe).toHaveBeenCalledOnce();
    expect(gw.transcribe).not.toHaveBeenCalled();
  });

  it("escalates to the gateway when the local engine under-yields", async () => {
    const stt = fakeSttEngine(""); // low-confidence / empty local result
    const gw = fakeGateway("gateway rescues the clip");
    const doc = await parseDocument(WAV, { stt: gw, sttEngine: stt, filename: "note.wav" });

    expect(doc.text).toBe("gateway rescues the clip");
    expect(stt.transcribe).toHaveBeenCalledOnce();
    expect(gw.transcribe).toHaveBeenCalledOnce();
    expect(doc.warnings.some((w) => w.includes("moonshine-fake"))).toBe(true);
  });

  it("skips an unavailable local engine and goes straight to the gateway", async () => {
    const stt = fakeSttEngine("unused", { available: false });
    const gw = fakeGateway("external only");
    const doc = await parseDocument(WAV, { stt: gw, sttEngine: stt, filename: "note.wav" });

    expect(doc.text).toBe("external only");
    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(doc.warnings.some((w) => w.includes("unavailable"))).toBe(true);
  });

  it("returns empty (honest) when the local engine fails AND no gateway is wired", async () => {
    const stt = fakeSttEngine("");
    const doc = await parseDocument(WAV, { sttEngine: stt, filename: "note.wav" });
    expect(doc.text).toBe("");
    expect(doc.source).toBe("none");
    expect(doc.warnings.some((w) => w.includes("stt-gateway"))).toBe(true);
  });
});
