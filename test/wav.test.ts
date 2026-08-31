import { describe, expect, it } from "vitest";
import { encodeWavPcm16, parseWavPcm16, WavError } from "../src/engines/moonshine/shared/wav.js";

/**
 * Hermetic WAV tests: the runner's audio contract (PCM16-only) and the
 * browser escalation path (encodeWavPcm16). Hand-built RIFF chunks cover what
 * the encoder cannot produce (multi-channel, exotic formats, chunk order).
 */

// ── RIFF builders ─────────────────────────────────────────────────────────────

function chunk(id: string, body: number[]): Uint8Array {
  const size = body.length + (body.length % 2); // chunks are word-aligned
  const out = new Uint8Array(8 + size);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(12 + body);
  for (let i = 0; i < 4; i++) out[i] = "RIFF".charCodeAt(i);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([87, 65, 86, 69], 8); // "WAVE"
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function fmtChunk(
  opts: { format?: number; channels?: number; rate?: number; bits?: number } = {},
): Uint8Array {
  const { format = 1, channels = 1, rate = 16000, bits = 16 } = opts;
  const v = new DataView(new ArrayBuffer(16));
  v.setUint16(0, format, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, rate * channels * (bits / 8), true);
  v.setUint16(12, channels * (bits / 8), true);
  v.setUint16(14, bits, true);
  return chunk("fmt ", Array.from(new Uint8Array(v.buffer)));
}

/** `frames` interleaved frames of constant sample value 257 (0x0101 LE). */
function dataChunk(frames: number, channels = 1): Uint8Array {
  return chunk("data", new Array(frames * channels * 2).fill(1));
}

// ── encode/parse round-trip ──────────────────────────────────────────────────

describe("encodeWavPcm16 → parseWavPcm16", () => {
  it("round-trips mono samples, rate, and channel count", () => {
    const wav = encodeWavPcm16(Float32Array.from([-1, -0.5, 0, 0.5, 1]), 16000);
    const parsed = parseWavPcm16(wav);
    expect(parsed.channels).toBe(1);
    expect(parsed.sampleRate).toBe(16000);
    // 0.5 * 0x7fff truncates to 16383; -0.5 * 0x8000 is exact.
    expect(Array.from(parsed.pcm)).toEqual([-32768, -16384, 0, 16383, 32767]);
  });

  it("clamps before scaling so ±1 overshoot does not wrap", () => {
    const wav = encodeWavPcm16(Float32Array.from([2, -2]), 8000);
    expect(Array.from(parseWavPcm16(wav).pcm)).toEqual([32767, -32768]);
  });
});

// ── parse coverage the encoder can't produce ─────────────────────────────────

describe("parseWavPcm16 — RIFF walk", () => {
  it("parses stereo data interleaved", () => {
    const parsed = parseWavPcm16(riff([fmtChunk({ channels: 2 }), dataChunk(3, 2)]));
    expect(parsed.channels).toBe(2);
    expect(parsed.pcm.length).toBe(3 * 2);
  });

  it("accepts fmt and data in either order (recorders vary)", () => {
    const parsed = parseWavPcm16(riff([dataChunk(2), fmtChunk()]));
    expect(parsed.pcm.length).toBe(2);
    expect(parsed.sampleRate).toBe(16000);
  });

  it("skips unknown odd-sized chunks including their pad byte", () => {
    const wav = riff([fmtChunk(), chunk("LIST", [65, 66, 67]), dataChunk(2)]);
    expect(parseWavPcm16(wav).pcm.length).toBe(2);
  });

  it("drops a trailing partial frame instead of failing", () => {
    // Stereo, 3 bytes of data: 1 complete frame (4B) + 2 leftover bytes.
    const parsed = parseWavPcm16(riff([fmtChunk({ channels: 2 }), chunk("data", [1, 1, 1, 1, 1, 1])]));
    expect(parsed.pcm.length).toBe(2);
  });
});

describe("parseWavPcm16 — error codes", () => {
  const expectCode = (bytes: Uint8Array, code: string) => {
    expect(() => parseWavPcm16(bytes)).toThrowError(expect.objectContaining({ code }));
  };

  it("not_wav for garbage magic", () => {
    expectCode(new Uint8Array([79, 103, 103, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "not_wav");
    expectCode(new TextEncoder().encode("RIFF____WAVX"), "not_wav");
  });

  it("truncated when a chunk declares past the end of the buffer", () => {
    const whole = riff([fmtChunk(), dataChunk(4)]);
    expectCode(whole.subarray(0, whole.length - 2), "truncated");
  });

  it("missing_fmt / missing_data", () => {
    expectCode(riff([dataChunk(2)]), "missing_fmt");
    expectCode(riff([fmtChunk()]), "missing_data");
  });

  it("unsupported_format for IEEE float (3) and extensible (0xFFFE)", () => {
    expectCode(riff([fmtChunk({ format: 3 }), dataChunk(2)]), "unsupported_format");
    expectCode(riff([fmtChunk({ format: 0xfffe }), dataChunk(2)]), "unsupported_format");
  });

  it("unsupported_bits for 24-bit", () => {
    expectCode(riff([fmtChunk({ bits: 24 }), dataChunk(6)]), "unsupported_bits");
  });

  it("unsupported_channels for 0 and 9 channels", () => {
    expectCode(riff([fmtChunk({ channels: 0 }), dataChunk(2)]), "unsupported_channels");
    expectCode(riff([fmtChunk({ channels: 9 }), dataChunk(18)]), "unsupported_channels");
  });

  it("exposes WavError as a typed error", () => {
    try {
      parseWavPcm16(new Uint8Array(4));
    } catch (err) {
      expect(err).toBeInstanceOf(WavError);
      return;
    }
    throw new Error("expected a throw");
  });
});
