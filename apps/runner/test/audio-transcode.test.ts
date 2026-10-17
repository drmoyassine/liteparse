import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  floatToPcm16,
  looksLikeOggOpus,
  resampleTo16k,
  transcodeOggOpusToWav,
  wrapWavPcm16,
} from "../src/audio-transcode.js";

function oggPage(payload: Buffer, type: number, granule = 0n, seq = 0): Buffer {
  const lacing = [payload.length];
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0);
  header[5] = type;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(0x1234abcd, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) header[27 + i] = lacing[i];
  // CRC deliberately zeroed — looksLikeOggOpus does not validate CRC.
  return Buffer.concat([header, payload]);
}

const OPUS_HEAD = Buffer.concat([
  Buffer.from("OpusHead"),
  Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00]),
]);
const OPUS_TAGS = Buffer.concat([
  Buffer.from("OpusTags"),
  Buffer.from([0x07, 0x00, 0x00, 0x00]),
  Buffer.from("fixture"),
]);

describe("looksLikeOggOpus", () => {
  it("accepts an ogg stream whose first page carries OpusHead at byte 28", () => {
    const ogg = Buffer.concat([
      oggPage(OPUS_HEAD, 2, 0n, 0),
      oggPage(OPUS_TAGS, 0, 0n, 1),
    ]);
    expect(looksLikeOggOpus(new Uint8Array(ogg))).toBe(true);
  });

  it("rejects ogg-vorbis (no OpusHead), non-ogg, and truncated buffers", () => {
    const vorbisPage = oggPage(Buffer.concat([Buffer.from("\x01vorbis"), Buffer.alloc(23)]), 2);
    expect(looksLikeOggOpus(new Uint8Array(vorbisPage))).toBe(false);
    expect(looksLikeOggOpus(new Uint8Array(Buffer.from("not an ogg at all, definitely not")))).toBe(false);
    expect(looksLikeOggOpus(new Uint8Array(Buffer.from("OggS")))).toBe(false);
  });
});

describe("resampleTo16k", () => {
  it("passes through 16 kHz input untouched", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    expect(resampleTo16k(input, 16000)).toBe(input);
  });

  it("downsamples 48 kHz → 16 kHz preserving length ratio and DC level", () => {
    const input = new Float32Array(480).fill(0.5);
    const out = resampleTo16k(input, 48000);
    expect(out.length).toBe(160);
    for (const v of out) expect(v).toBeCloseTo(0.5, 5);
  });

  it("handles mono-sample input", () => {
    expect(resampleTo16k(new Float32Array([0.25]), 48000).length).toBeGreaterThanOrEqual(1);
  });
});

describe("floatToPcm16 + wrapWavPcm16", () => {
  it("clamps and quantizes to int16", () => {
    const pcm = floatToPcm16(new Float32Array([0.5, -0.5, 2.0, -2.0]));
    expect(pcm[0]).toBeCloseTo(16384, -2);
    expect(pcm[1]).toBeCloseTo(-16384, -2);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
  });

  it("wraps a 44-byte RIFF/WAVE mono 16 kHz header", () => {
    const pcm = new Int16Array([100, -100, 200]);
    const wav = wrapWavPcm16(pcm, 16000);
    expect(wav.length).toBe(44 + pcm.length * 2);
    const ascii = (b: Uint8Array) => String.fromCharCode(...b);
    expect(ascii(wav.subarray(0, 4))).toBe("RIFF");
    expect(ascii(wav.subarray(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
    // first sample lands after the header, little-endian
    expect(view.getInt16(44, true)).toBe(100);
  });
});

// Integration: decode a real Ogg Opus voice note. Synthetic encoders are not
// trusted for this — WhatsApp voice notes come from libopus-based encoders and
// that is the contract that matters. Drop a real (sanitized) voice note at
// test/fixtures/voice-note.ogg to enable; the live acceptance evidence is a
// real WhatsApp voice note flowing through the channel after deploy.
const REAL_FIXTURE = resolve(__dirname, "fixtures/voice-note.ogg");
describe.skipIf(!existsSync(REAL_FIXTURE))("transcodeOggOpusToWav (real fixture)", () => {
  it("decodes to non-silent 16 kHz mono WAV PCM16", async () => {
    const { readFileSync } = await import("node:fs");
    const ogg = new Uint8Array(readFileSync(REAL_FIXTURE));
    expect(looksLikeOggOpus(ogg)).toBe(true);
    const { wav, durationMs } = await transcodeOggOpusToWav(ogg);
    expect(durationMs).toBeGreaterThan(0);
    expect(wav.length).toBeGreaterThan(44);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(24, true)).toBe(16000);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeGreaterThan(100);
  });
});
