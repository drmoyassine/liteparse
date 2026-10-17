/**
 * audio-transcode.ts — server-side OGG/Opus → WAV PCM16 pre-flight for
 * /transcribe (TASK-221).
 *
 * Channel voice notes arrive as Ogg Opus (the WhatsApp standard), but the
 * runner's STT contract is WAV PCM16 (the browser path decodes client-side
 * via decodeAudioData). Server callers have no AudioContext — so the runner
 * now carries the decode itself: pure WASM (`ogg-opus-decoder`, libopus
 * compiled to WebAssembly — consistent with the Dockerfile's no-apt-get
 * posture; the audio NEVER leaves the box, DEC-087's self-host boundary).
 *
 * Pipeline: Ogg demux + Opus decode (WASM, 48 kHz Float32) → mono mixdown →
 * linear resample to 16 kHz → Int16 PCM → 44-byte WAV header. Speech-band
 * content survives the crude resampler fine; Moonshine's confidence floors
 * are the honest quality gate.
 */
import { OggOpusDecoder } from "ogg-opus-decoder";
import type { DecodedAudio } from "ogg-opus-decoder";

const TARGET_RATE = 16000;

// One shared WASM instance — decode() is synchronous per call; concurrent
// requests serialize on the runner's shared STT semaphore anyway.
let _decoder: OggOpusDecoder | null = null;
async function getDecoder(): Promise<OggOpusDecoder> {
  if (!_decoder) {
    _decoder = new OggOpusDecoder();
    await _decoder.ready;
  }
  return _decoder;
}

/** Ogg page sync + Opus identification header within the first page. */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  if (bytes.length < 36) return false;
  if (bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) return false; // "OggS"
  // OpusHead magic sits at byte 28 of the first page (after the 27-byte page
  // header); check it so plain Ogg Vorbis falls through to the honest 422.
  const magic = String.fromCharCode(...bytes.slice(28, 36));
  return magic === "OpusHead";
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Linear-interpolation resample (any rate → 16 kHz), mono in / mono out. */
export function resampleTo16k(mono: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === TARGET_RATE || mono.length === 0) return mono;
  const outLength = Math.max(1, Math.round((mono.length * TARGET_RATE) / sampleRate));
  const out = new Float32Array(outLength);
  const step = mono.length > 1 ? (mono.length - 1) / (outLength - 1) : 0;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = mono[idx] ?? 0;
    const b = mono[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function wrapWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return new Uint8Array(buf);
}

export interface TranscodeResult {
  wav: Uint8Array;
  durationMs: number;
}

/**
 * Decode an Ogg Opus stream to 16 kHz mono WAV PCM16. Throws when the stream
 * carries no decodable audio — the caller turns that into the honest 422.
 */
export async function transcodeOggOpusToWav(bytes: Uint8Array): Promise<TranscodeResult> {
  const decoder = await getDecoder();
  const result: DecodedAudio = decoder.decode(bytes);
  const channels = (result?.channelData ?? []) as Float32Array[];
  const sampleRate = result?.sampleRate || 48000;
  const decoded = channels.filter((c) => c && c.length > 0);
  if (decoded.length === 0 || decoded[0].length === 0) {
    throw new Error("ogg/opus stream decoded to zero samples");
  }

  // Mono mixdown.
  const length = decoded[0].length;
  const mono = new Float32Array(length);
  for (const ch of decoded) {
    for (let i = 0; i < length; i++) mono[i] += (ch[i] ?? 0) / decoded.length;
  }

  const resampled = resampleTo16k(mono, sampleRate);
  const durationMs = Math.round((resampled.length / TARGET_RATE) * 1000);
  return { wav: wrapWavPcm16(floatToPcm16(resampled), TARGET_RATE), durationMs };
}
