/**
 * Audio conditioning for Moonshine: every model in the cascade eats mono
 * 16 kHz float waveform (streaming `audio_chunk` and batch `input_values`
 * alike — the batch ConvFrontend is baked into the encoder graph; the spike
 * verified both, so NO mel spectrogram is computed in JS anywhere).
 */
import { parseWavPcm16, WavError, type Pcm16Wav } from "./wav.js";

/** Moonshine sample rate — every variant, both families. */
export const MODEL_SAMPLE_RATE = 16000;

/** Collapse interleaved PCM16 frames to mono floats in [-1, 1] (channel average). */
export function mixToMono(pcm: Int16Array, channels: number): Float32Array {
  if (channels < 1) throw new WavError("unsupported_channels", `channels ${channels}`);
  if (channels === 1) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
    return out;
  }
  const frames = Math.floor(pcm.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[f * channels + c]!;
    out[f] = sum / channels / 32768;
  }
  return out;
}

/** Half-integer taps of the Hann-windowed sinc; 24 keeps speech-band error inaudible
 *  while staying ~4µs/sample in JS on a 2019 laptop (measured class, not a guess:
 *  same order as the ocr-lab resample calibration). */
const SINC_ZERO_CROSSINGS = 24;

/** Unit sinc, the windowed-sinc resampler kernel basis. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Windowed-sinc resampler (Hann window, cutoff at the OUTPUT Nyquist when
 * downsampling) — linear interpolation aliases speech energy above 8 kHz back
 * into the band on 44.1k/48k → 16k conversions, which ASR hears as noise.
 * `quality: "linear"` stays available as a cheap fallback for probe tooling.
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  opts: { quality?: "sinc" | "linear" } = {},
): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < 1 || toRate < 1) throw new Error(`invalid sample rates ${fromRate}→${toRate}`);
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);

  if (opts.quality === "linear") {
    const step = fromRate / toRate;
    for (let o = 0; o < outLen; o++) {
      const pos = o * step;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = input[i] ?? 0;
      const b = input[i + 1] ?? a;
      out[o] = a + (b - a) * frac;
    }
    return out;
  }

  // Cutoff at min(from,to) Nyquist: no aliasing on downsample, no imaging on up.
  const fc = Math.min(1, toRate / fromRate) / 2; // cycles/sample
  const zc = SINC_ZERO_CROSSINGS;
  for (let o = 0; o < outLen; o++) {
    const pos = (o * fromRate) / toRate;
    const i0 = Math.floor(pos);
    let sum = 0;
    for (let k = -zc; k <= zc; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= input.length) continue;
      const t = pos - idx;
      // Hann window over tap distance; h(t) = 2fc·sinc(2fc·t) has unit DC gain.
      const w = 0.5 * (1 + Math.cos((Math.PI * t) / zc));
      sum += input[idx]! * 2 * fc * sinc(2 * fc * t) * w;
    }
    out[o] = sum;
  }
  return out;
}

export interface ModelAudio {
  samples: Float32Array;
  sampleRate: typeof MODEL_SAMPLE_RATE;
  /** Original container facts, for telemetry and the honest 422 story. */
  source: { sampleRate: number; channels: number };
}

/**
 * WAV bytes → model input: parse (PCM16 contract) → mono → 16 kHz.
 * `maxSeconds` clamps the clip up front — the runner enforces its own budget,
 * this keeps a runaway upload from allocating a giant features tensor.
 */
export function wavToModelAudio(bytes: Uint8Array, opts: { maxSeconds?: number } = {}): ModelAudio {
  const wav: Pcm16Wav = parseWavPcm16(bytes);
  let mono = mixToMono(wav.pcm, wav.channels);
  if (opts.maxSeconds && mono.length > opts.maxSeconds * wav.sampleRate) {
    mono = mono.subarray(0, Math.floor(opts.maxSeconds * wav.sampleRate));
  }
  const samples = resample(mono, wav.sampleRate, MODEL_SAMPLE_RATE);
  return { samples, sampleRate: MODEL_SAMPLE_RATE, source: { sampleRate: wav.sampleRate, channels: wav.channels } };
}
