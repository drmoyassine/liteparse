import { describe, expect, it, vi } from "vitest";
import { createDictationCore, type DictationEngine } from "../src/stt/streaming/dictation-worker.js";
import { parseWavPcm16 } from "../src/engines/moonshine/shared/wav.js";
import type { SttResult, SttTranscribeOptions } from "../src/types.js";
import type { DictationOutbound } from "../src/stt/streaming/protocol.js";

/**
 * The dictation protocol core with the engine INJECTED — every policy is
 * deterministic here: the WAV contract handed to the engine, hangover finals,
 * blip drops, stop-flush ordering, the interim throttle + supersede rule, and
 * engine-failure degradation. Real-model decode behavior is the moonshine
 * tests' job; this file pins the PIPELINE around it.
 */

const S = 16000;
const SPEECH = 0.1;

/** ms of audio at 16 kHz, constant level (interim-safe: VAD sees RMS only). */
function speech(ms: number, level = SPEECH): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * S)).fill(level);
}

type Handler = (
  bytes: Uint8Array,
  opts: SttTranscribeOptions,
) => SttResult | Promise<SttResult> | Error;

function setup(handler: Handler, now?: () => number) {
  const posted: DictationOutbound[] = [];
  const transcribe = vi.fn(async (bytes: Uint8Array, opts: SttTranscribeOptions) => {
    const r = handler(bytes, opts);
    if (r instanceof Error) throw r;
    return await r;
  });
  const warm = vi.fn(async () => undefined);
  const engine: DictationEngine = { transcribe, warm };
  let clock = 0;
  const core = createDictationCore({
    engine,
    post: (m) => posted.push(m),
    now: now ?? (() => clock),
  });
  return {
    core,
    posted,
    transcribe,
    warm,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Let queued microtasks (decode → post) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The utterance PCM the engine should receive for `ms` of mixed audio. */
const pcmSamples = (ms: number) => Math.round((ms / 1000) * S);

const finals = (posted: DictationOutbound[]) => posted.filter((m) => m.type === "final");
const interims = (posted: DictationOutbound[]) => posted.filter((m) => m.type === "interim");

describe("dictation core — session lifecycle", () => {
  it("start posts ready and warms the slot-1 model in the background", () => {
    const { core, posted, warm } = setup(() => ({ text: "x" }));
    core.onMessage({ type: "start" });
    expect(posted).toEqual([{ type: "ready", language: "en" }]);
    expect(warm).toHaveBeenCalledWith("en");
  });

  it("chunk before start is a protocol error, not a crash", () => {
    const { core, posted } = setup(() => ({ text: "x" }));
    core.onMessage({ type: "chunk", samples: speech(100), sampleRate: S });
    expect(posted).toEqual([
      { type: "error", stage: "protocol", message: expect.stringContaining("chunk before start") },
    ]);
  });

  it("stop without a session is an immediate stopped (idempotent idle)", async () => {
    const { core, posted } = setup(() => ({ text: "x" }));
    core.onMessage({ type: "stop" });
    await flush();
    expect(posted).toEqual([{ type: "stopped" }]);
  });
});

describe("dictation core — finals", () => {
  it("hands the engine a 16 kHz mono WAV PCM16 of the utterance and posts the final", async () => {
    let seen: { sampleRate: number; channels: number; samples: number } | null = null;
    const { core, posted } = setup((bytes) => {
      const wav = parseWavPcm16(bytes);
      seen = { sampleRate: wav.sampleRate, channels: wav.channels, samples: wav.pcm.length };
      return { text: "hello there", confidence: 0.91 };
    });
    core.onMessage({ type: "start" });
    core.onMessage({ type: "chunk", samples: speech(400), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(500, 0), sampleRate: S }); // hangover close
    await flush();

    expect(seen).toEqual({ sampleRate: 16000, channels: 1, samples: pcmSamples(900) });
    const f = finals(posted);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      type: "final",
      text: "hello there",
      confidence: 0.91,
      language: "en",
      reason: "hangover",
      startMs: 0,
      endMs: 900,
    });
  });

  it("resamples 48 kHz capture frames to 16 kHz before VAD/decode", async () => {
    let samples = -1;
    const { core } = setup((bytes) => {
      samples = parseWavPcm16(bytes).pcm.length;
      return { text: "ok" };
    });
    core.onMessage({ type: "start" });
    // 480 ms of speech at 48 kHz → 7680 samples at 16 kHz.
    core.onMessage({
      type: "chunk",
      samples: new Float32Array(23_040).fill(SPEECH),
      sampleRate: 48_000,
    });
    core.onMessage({ type: "chunk", samples: speech(600, 0), sampleRate: S });
    await flush();
    expect(samples).toBe(pcmSamples(480) + pcmSamples(600));
  });

  it("a sub-minUtteranceMs blip is dropped with an audio warning, not a final", async () => {
    const { core, posted, transcribe } = setup(() => ({ text: "never" }));
    core.onMessage({ type: "start" });
    core.onMessage({ type: "chunk", samples: speech(100), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(600, 0), sampleRate: S });
    await flush();
    expect(finals(posted)).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
    const err = posted.find((m) => m.type === "error");
    expect(err).toMatchObject({ stage: "audio", message: expect.stringMatching(/discarded \d+ms blip/) });
  });

  it("forwards the session language and reports it on the final", async () => {
    const { core, posted, transcribe } = setup(() => ({ text: "مرحبا", confidence: 0.8 }));
    core.onMessage({ type: "start", language: "ar" });
    core.onMessage({ type: "chunk", samples: speech(400), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(500, 0), sampleRate: S });
    await flush();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), { language: "ar" });
    expect(finals(posted)[0]).toMatchObject({ language: "ar", text: "مرحبا" });
  });
});

describe("dictation core — stop", () => {
  it("flushes the open utterance and posts stopped only AFTER the final", async () => {
    const { core, posted } = setup(() => ({ text: "last words" }));
    core.onMessage({ type: "start" });
    core.onMessage({ type: "chunk", samples: speech(300), sampleRate: S });
    core.onMessage({ type: "stop" });
    await flush();

    const types = posted.map((m) => m.type);
    expect(types.indexOf("final")).toBeLessThan(types.indexOf("stopped"));
    const f = finals(posted);
    expect(f[0]).toMatchObject({ text: "last words", reason: "flush", startMs: 0, endMs: 300 });
  });

  it("drops chunks arriving after stop (late worklet frames)", async () => {
    const { core, posted, transcribe } = setup(() => ({ text: "t" }));
    core.onMessage({ type: "start" });
    core.onMessage({ type: "chunk", samples: speech(300), sampleRate: S });
    core.onMessage({ type: "stop" });
    await flush();
    const calls = transcribe.mock.calls.length;
    core.onMessage({ type: "chunk", samples: speech(300), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(600, 0), sampleRate: S });
    await flush();
    expect(transcribe.mock.calls.length).toBe(calls); // nothing new decoded
    expect(finals(posted)).toHaveLength(1);
  });
});

describe("dictation core — interims", () => {
  it("fires a trailing-buffer preview past the throttle window, then the final supersedes it", async () => {
    const { core, posted, transcribe, advance } = setup((bytes) => {
      const n = parseWavPcm16(bytes).pcm.length;
      return { text: `n=${n}`, confidence: 0.7 };
    });
    core.onMessage({ type: "start" });
    for (let i = 0; i < 12; i++) {
      advance(100);
      core.onMessage({ type: "chunk", samples: speech(100), sampleRate: S });
    }
    await flush();
    // 1200 ms of speech: one interim (first window) — the interval keeps the
    // rest quiet while the buffer grows.
    expect(interims(posted)).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledTimes(1);

    core.onMessage({ type: "chunk", samples: speech(600, 0), sampleRate: S });
    await flush();
    const ints = interims(posted);
    const f = finals(posted);
    expect(f).toHaveLength(1);
    // The interim decoded a PREFIX of the utterance; the final has it all.
    const interimLen = Number(/n=(\d+)/.exec(ints[0]!.text!)![1]);
    const finalLen = Number(/n=(\d+)/.exec(f[0]!.text!)![1]);
    expect(interimLen).toBeLessThan(finalLen);
    expect(f[0]).toMatchObject({ reason: "hangover" });
  });

  it("suppresses gate-emptied previews (an interim must say something)", async () => {
    const { core, posted } = setup(() => ({ text: "", confidence: 0.1 })); // gate-tripped shape
    core.onMessage({ type: "start" });
    for (let i = 0; i < 12; i++) {
      core.onMessage({ type: "chunk", samples: speech(100), sampleRate: S });
    }
    await flush();
    expect(interims(posted)).toHaveLength(0);
  });

  it("drops a late interim whose utterance already finalized (supersede)", async () => {
    let resolveFirst: (r: SttResult) => void = () => {};
    let call = 0;
    const { core, posted } = setup(() => {
      call++;
      if (call === 1) {
        return new Promise<SttResult>((res) => {
          resolveFirst = res;
        });
      }
      return { text: "the final text" };
    });
    core.onMessage({ type: "start" });
    for (let i = 0; i < 12; i++) {
      core.onMessage({ type: "chunk", samples: speech(100), sampleRate: S });
    }
    await flush();
    expect(posted.some((m) => m.type === "interim")).toBe(false); // still decoding

    core.onMessage({ type: "chunk", samples: speech(600, 0), sampleRate: S });
    await flush(); // final posts from call 2…
    expect(finals(posted)).toHaveLength(1);

    resolveFirst({ text: "stale preview", confidence: 0.9 }); // …the interim lands late
    await flush();
    expect(posted.some((m) => m.type === "interim")).toBe(false); // superseded → dropped
  });
});

describe("dictation core — degradation", () => {
  it("an engine failure on a final posts an engine error and an empty final, and the session continues", async () => {
    let call = 0;
    const { core, posted } = setup(() => {
      call++;
      if (call === 1) return new Error("ort blew up");
      return { text: "recovered" };
    });
    core.onMessage({ type: "start" });
    core.onMessage({ type: "chunk", samples: speech(400), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(500, 0), sampleRate: S });
    await flush();
    const f1 = finals(posted);
    expect(f1[0]).toMatchObject({ text: "", reason: "hangover" });
    expect(posted.some((m) => m.type === "error" && m.message.includes("ort blew up"))).toBe(true);

    core.onMessage({ type: "chunk", samples: speech(400), sampleRate: S });
    core.onMessage({ type: "chunk", samples: speech(500, 0), sampleRate: S });
    await flush();
    const f2 = finals(posted);
    expect(f2).toHaveLength(2);
    expect(f2[1]).toMatchObject({ text: "recovered" });
  });
});
