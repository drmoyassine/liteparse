/**
 * audio-transcode.ts — server-side audio → WAV PCM16 pre-flight for
 * /transcribe (TASK-221).
 *
 * Channel voice notes arrive as Ogg Opus (the WhatsApp standard), but the
 * runner's STT contract is WAV PCM16 (the browser path decodes client-side
 * via decodeAudioData). Server callers have no AudioContext — so the runner
 * carries the decode itself, via the pinned static ffmpeg binary baked into
 * the image (same fetch + sha256-verify pattern as the Moonshine models —
 * see the Dockerfile). The audio NEVER leaves the box (DEC-087 self-host
 * boundary).
 *
 * History: a pure-WASM decoder (ogg-opus-decoder) was tried first and
 * DISQUALIFIED — it silently returned zero frames on real WhatsApp-style
 * files (both Node 22 and Node 26; fail-silent is the worst failure mode for
 * a media pipeline). ffmpeg decodes everything (ogg/webm/mp3/m4a) and fails
 * LOUDLY.
 *
 * Pipeline: ffmpeg (stdin → PCM s16le, mono, 16 kHz) → 44-byte WAV header.
 * Speech-band content survives the resample fine; Moonshine's confidence
 * floors are the honest quality gate.
 */
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const TARGET_RATE = 16000;
/** Path to the ffmpeg binary — ffmpeg-static ships a platform build at
 * install time; FFMPEG_PATH overrides (the Docker image needs no override). */
const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";

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

/** True when an ffmpeg binary is reachable (guards tests / graceful skips). */
export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Transcode ANY decodable audio (Ogg Opus, webm, mp3, m4a — whatever the
 * bundled ffmpeg handles) to 16 kHz mono WAV PCM16. Throws with ffmpeg's
 * stderr on undecodable input — the caller turns that into the honest 422.
 */
export async function transcodeToWav(bytes: Uint8Array): Promise<TranscodeResult> {
  return new Promise<TranscodeResult>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",            // ignore embedded cover-art streams
        "-map", "0:a:0",  // first audio stream only
        "-ac", "1",       // mono mixdown
        "-ar", String(TARGET_RATE),
        "-acodec", "pcm_s16le",
        "-f", "s16le",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
    };

    // The runner's whole-request deadline bounds this; enforce locally too so
    // a stuck ffmpeg cannot pin a semaphore slot past it.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("ffmpeg transcode timed out"));
    }, 110_000);

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => { if (stderr.length < 4000) stderr += c.toString(); });
    child.on("error", (err) => { clearTimeout(timer); fail(err); });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (code !== 0 || pcm.length < 2) {
        fail(new Error(
          `ffmpeg failed (code ${code}): ${stderr.trim().slice(0, 300) || "no audio output"}`,
        ));
        return;
      }
      const durationMs = Math.round((pcm.length / 2 / TARGET_RATE) * 1000);
      const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
      resolve({ wav: wrapWavPcm16(int16, TARGET_RATE), durationMs });
    });

    // Large payloads: write may back-pressure — end() flushes the whole buffer.
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    child.stdin.on("error", (err) => fail(err));
    child.stdin.end(input);
  });
}
