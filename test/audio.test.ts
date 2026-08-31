import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_RATE,
  mixToMono,
  resample,
  wavToModelAudio,
} from "../src/engines/moonshine/shared/audio.js";
import { encodeWavPcm16 } from "../src/engines/moonshine/shared/wav.js";
import { WavError } from "../src/engines/moonshine/shared/wav.js";

/**
 * Hermetic audio-conditioning tests: mono mixdown, resampler fidelity (the
 * anti-aliasing story is why sinc exists), and the WAV→model-input pipeline.
 */

describe("mixToMono", () => {
  it("scales mono PCM to [-1, 1] floats", () => {
    expect(Array.from(mixToMono(Int16Array.from([-32768, 16384]), 1))).toEqual([-1, 0.5]);
  });

  it("channel-averages stereo frames", () => {
    // Values stay inside int16 (Int16Array.from wraps out-of-range, 32768 → -32768).
    const stereo = Int16Array.from([-32768, 0, 16384, -16384, 8192, 0]);
    expect(Array.from(mixToMono(stereo, 2))).toEqual([-0.5, 0, 4096 / 32768]);
  });

  it("drops a trailing incomplete frame", () => {
    const out = mixToMono(Int16Array.from([100, 200, 300]), 2);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(150 / 32768);
  });

  it("rejects zero channels as a WavError", () => {
    expect(() => mixToMono(new Int16Array(4), 0)).toThrowError(WavError);
  });
});

describe("resample", () => {
  it("returns the input untouched at equal rates", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("upsamples 2:1 with linear hitting the even-index exact values", () => {
    const input = Float32Array.from([0, 0.5, 1, -0.5]);
    const out = resample(input, 8000, 16000, { quality: "linear" });
    expect(out.length).toBe(8);
    // Output positions 0,2,4,6 sit exactly on input samples.
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
    expect(out[4]).toBeCloseTo(1, 6);
    expect(out[6]).toBeCloseTo(-0.5, 6);
  });

  it("preserves DC level through the sinc path on 32k→16k (unit DC gain)", () => {
    const input = new Float32Array(4096).fill(0.25);
    const out = resample(input, 32000, 16000); // default sinc
    // Interior samples (edges lose window taps); 1e-3 covers window ripple.
    for (let i = 100; i < out.length - 100; i++) {
      expect(Math.abs(out[i]! - 0.25)).toBeLessThan(1e-3);
    }
  });

  it("sinc 48k→16k lands a 1 kHz sine back on its samples", () => {
    const n = 4800; // 0.1 s at 48 k
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(1600);
    for (let i = 100; i < 1500; i++) {
      expect(Math.abs(out[i]! - Math.sin((2 * Math.PI * 1000 * i) / 16000))).toBeLessThan(1e-2);
    }
  });

  it("rejects invalid rates", () => {
    expect(() => resample(new Float32Array(4), 0, 16000)).toThrowError(/invalid sample rates/);
  });
});

describe("wavToModelAudio", () => {
  it("passes 16 kHz mono WAV through at length", () => {
    const wav = encodeWavPcm16(new Float32Array(1600).fill(0.3), 16000);
    const audio = wavToModelAudio(wav);
    expect(audio.sampleRate).toBe(MODEL_SAMPLE_RATE);
    expect(audio.samples.length).toBe(1600);
    expect(audio.source).toEqual({ sampleRate: 16000, channels: 1 });
  });

  it("mixes and downsamples 48 kHz stereo to 16 kHz mono", () => {
    // encodeWavPcm16 is mono-only, so hand-build the stereo WAV (phase-inverted
    // channels → the mono mix is silence; only a correct mix+resample yields it).
    const frames = 4800; // 0.1 s at 48 k
    const body = new Uint8Array(frames * 4);
    for (let f = 0; f < frames; f++) {
      const v = Math.round(0.5 * 0x7fff);
      const s = f < 8 || f >= frames - 8 ? 0 : v; // quiet edges for the sinc window
      body.set([s & 0xff, (s >> 8) & 0xff, (-s) & 0xff, ((-s) >> 8) & 0xff], f * 4);
    }
    const wav = new Uint8Array(44 + body.length);
    const v = new DataView(wav.buffer);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
    str(0, "RIFF"); v.setUint32(4, 36 + body.length, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, 48000, true); v.setUint32(28, 48000 * 4, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, body.length, true);
    wav.set(body, 44);

    const audio = wavToModelAudio(wav);
    expect(audio.source).toEqual({ sampleRate: 48000, channels: 2 });
    expect(audio.samples.length).toBe(1600);
    for (let i = 100; i < audio.samples.length - 100; i++) {
      expect(Math.abs(audio.samples[i]!)).toBeLessThan(1e-3);
    }
  });

  it("clamps to maxSeconds before resampling", () => {
    const wav = encodeWavPcm16(new Float32Array(3 * 16000).fill(0.1), 16000);
    const audio = wavToModelAudio(wav, { maxSeconds: 1 });
    expect(audio.samples.length).toBe(16000);
  });
});
