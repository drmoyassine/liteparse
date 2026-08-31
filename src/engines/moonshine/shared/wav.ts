/**
 * Minimal WAV (RIFF) PCM16 reader/writer — the runner's audio contract.
 *
 * The server STT engine accepts WAV PCM16 only (pure-JS parse, zero deps):
 * browsers decode webm/opus/mp3 themselves via decodeAudioData and POST the
 * re-encoded WAV (encodeWavPcm16); `node-web-audio-api` remains a documented
 * escape hatch for server-side container decode, out of scope here.
 *
 * Everything in shared/ is runtime-agnostic: no node: imports, no ort imports —
 * imported identically by the Node engine (stt/moonshine-server) and, in Phase C,
 * the browser WASM engine.
 */

/** Typed parse/encode failure (the caller decides: 422 vs degraded empty result). */
export class WavError extends Error {
  constructor(
    public code:
      | "not_wav"
      | "truncated"
      | "missing_fmt"
      | "missing_data"
      | "unsupported_format"
      | "unsupported_bits"
      | "unsupported_channels",
    message: string,
  ) {
    super(message);
    this.name = "WavError";
  }
}

export interface Pcm16Wav {
  /** Interleaved samples across channels (use mixToMono to collapse). */
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

const ascii = (bytes: Uint8Array, offset: number, len: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + len));

/**
 * Strict RIFF chunk walk: `RIFF<size>WAVE`, then {fmt, data} in any order
 * (recorders emit LIST/other chunks between them). PCM (format 1), 16-bit,
 * 1–8 channels only — anything else is a client-decode contract violation.
 */
export function parseWavPcm16(bytes: Uint8Array): Pcm16Wav {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new WavError("not_wav", "not a RIFF/WAVE file (bad magic)");
  }
  // A declared RIFF size larger than the buffer happens with streamed writers;
  // only fail when the DATA we actually need is missing (truncated below).
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Uint8Array | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24);
    const body = offset + 8;
    if (body + size > bytes.length) throw new WavError("truncated", `chunk "${id}" declares ${size}B past end of buffer`);
    if (id === "fmt ") {
      if (size < 16) throw new WavError("truncated", "fmt chunk shorter than 16 bytes");
      const view = new DataView(bytes.buffer, bytes.byteOffset + body, size);
      fmt = {
        audioFormat: view.getUint16(0, true),
        channels: view.getUint16(2, true),
        sampleRate: view.getUint32(4, true),
        bits: view.getUint16(14, true),
      };
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    // Chunks are word-aligned: an odd size carries one pad byte.
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new WavError("missing_fmt", "no fmt chunk");
  if (!data) throw new WavError("missing_data", "no data chunk");
  if (fmt.audioFormat !== 1) {
    // 3 = IEEE float, 0xFFFE = extensible (subformat usually float for recorders).
    throw new WavError(
      "unsupported_format",
      `WAV audioFormat ${fmt.audioFormat} — contract is PCM (1); decode client-side`,
    );
  }
  if (fmt.bits !== 16) {
    throw new WavError("unsupported_bits", `WAV bitsPerSample ${fmt.bits} — contract is 16-bit`);
  }
  if (fmt.channels < 1 || fmt.channels > 8) {
    throw new WavError("unsupported_channels", `WAV channels ${fmt.channels} out of range`);
  }

  const usable = data.length - (data.length % (2 * fmt.channels));
  if (usable < 2 * fmt.channels) throw new WavError("truncated", "data chunk holds no complete frames");
  // Copy out of the source buffer: subarray aliases the caller's memory, and the
  // engine threads these samples through several resample/decode stages.
  const pcm = new Int16Array(usable / 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = bytes[data.byteOffset + i * 2]! | (bytes[data.byteOffset + i * 2 + 1]! << 8);
  }
  return { pcm, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/** Encode mono float samples [-1,1] as a minimal PCM16 WAV (browser escalation path). */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    // Clamp BEFORE scaling so ±1.0 doesn't wrap to -32768.
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}
