/**
 * Dictation worker — the D1 (VAD-chunked batch) live-transcription engine.
 *
 * Owns NOTHING platform-specific itself: the capture worklet frames the mic
 * (main thread relays), THIS module resamples → segments → transcribes each
 * finalized utterance through a local Moonshine {@link SttEngine}, posting
 * throttled interims from the open utterance's trailing buffer. The D2
 * incremental decoder (token-true streaming over the `.ort` state tensors) is
 * the upgrade path; D1 re-decodes the partial buffer, which is correct, just
 * not incremental — see ROADMAP Track 3 v1b for the D2 entry criterion
 * (a live spike of chunked state-threading semantics against the real graphs).
 *
 * Structure (mirrors worker/ocr-worker.ts):
 *  - `createDictationCore` — the whole protocol handler with the engine
 *    INJECTED, so every policy (hangover, interim throttle, stop flush,
 *    ordering) is hermetically testable (test/dictation-worker.test.ts);
 *  - a self-installing shell at the bottom that builds the real Moonshine
 *    engine and wires `self.onmessage` — installed ONLY inside a real worker
 *    scope, and NEVER importing worker/ocr-worker.ts (double worker-shell bug).
 */

import { MODEL_SAMPLE_RATE, resample } from "../../engines/moonshine/shared/audio.js";
import { encodeWavPcm16 } from "../../engines/moonshine/shared/wav.js";
import type { SttEngine, SttResult, SttTranscribeOptions } from "../../types.js";
import type { SttLanguage } from "../../engines/moonshine/shared/models.js";
import { RmsSegmenter, type SegmentationOptions } from "./segmentation.js";
import type { DictationInbound, DictationOutbound, DictationStart } from "./protocol.js";
import { isDictationChunk, isDictationStart, isDictationStop } from "./protocol.js";

// ─── interim policy ───────────────────────────────────────────────────────────

/** Don't interim before the utterance has this much audio (decode cost). */
const MIN_INTERIM_UTTERANCE_MS = 800;
/** Utterance length at which the first interim becomes due. */
const FIRST_INTERIM_MS = 900;
/** Minimum gap between interim decodes — the WASM RTF sets the real cadence. */
const INTERIM_INTERVAL_MS = 1200;

/** Engine surface the core needs (the browser engine's handle satisfies it). */
export type DictationEngine = Pick<SttEngine, "transcribe"> & {
  warm?(language: SttLanguage): Promise<void>;
  dispose?(): void;
};

export interface DictationCoreDeps {
  /** Local STT engine (injected — tests pass fakes, the shell passes Moonshine). */
  engine: DictationEngine;
  /** Outbound sink (the shell passes self.postMessage). */
  post(message: DictationOutbound): void;
  /** Clock for interim throttling, ms (tests pass a synthetic one). */
  now(): number;
}

export interface DictationCore {
  onMessage(message: DictationInbound): void;
}

interface Session {
  language: SttLanguage;
  interimEnabled: boolean;
  segmenter: RmsSegmenter;
  /** Id of the utterance currently OPEN (null between utterances) — an interim
   *  landing after its utterance closed is stale and must not post. */
  openUtteranceId: number | null;
  lastUtteranceId: number;
  lastInterimAt: number;
  interimInFlight: boolean;
  /** Finals + flushes serialize here so texts post in utterance order. */
  queue: Promise<void>;
  /** Set by stop(): no new interims, no chunk processing. */
  stopping: boolean;
}

/**
 * Protocol core. One instance per worker; a `start` message resets it (the
 * same worker can serve consecutive dictation sessions).
 */
export function createDictationCore(deps: DictationCoreDeps): DictationCore {
  const { engine, post } = deps;
  let session: Session | null = null;

  return { onMessage };

  function onMessage(message: DictationInbound): void {
    if (isDictationStart(message)) {
      start(message);
      return;
    }
    if (isDictationChunk(message)) {
      chunk(message.samples, message.sampleRate);
      return;
    }
    if (isDictationStop(message)) {
      stop();
      return;
    }
    post({ type: "error", stage: "protocol", message: "unrecognized dictation message" });
  }

  // ─── handlers ───────────────────────────────────────────────────────────────

  function start(msg: {
    language?: SttLanguage;
    interim?: boolean;
    vad?: Partial<SegmentationOptions>;
  }): void {
    const language: SttLanguage = msg.language ?? "en";
    session = {
      language,
      interimEnabled: msg.interim ?? true,
      segmenter: new RmsSegmenter(msg.vad),
      openUtteranceId: null,
      lastUtteranceId: 0,
      lastInterimAt: -Infinity,
      interimInFlight: false,
      queue: Promise.resolve(),
      stopping: false,
    };
    post({ type: "ready", language });
    // Warm the slot-1 model in the background (mic-intent preload): the cold
    // load (~139 MB first visit, IndexedDB afterwards) would otherwise land
    // on the FIRST utterance's final. Interims/finals before warm finishes
    // still work — they just await the same engine construction.
    void engine.warm?.(language).catch((err: unknown) => {
      post({
        type: "error",
        stage: "engine",
        message: `model warm-up failed (${errText(err)}) — first utterance pays the load cost`,
      });
    });
  }

  function chunk(samples: Float32Array, sampleRate: number): void {
    const s = session;
    if (!s) {
      post({ type: "error", stage: "protocol", message: "chunk before start — send {type:'start'} first" });
      return;
    }
    if (s.stopping) return; // stop() flushed; late frames drop silently

    let mono: Float32Array;
    try {
      mono = resample(samples, sampleRate, MODEL_SAMPLE_RATE);
    } catch (err) {
      post({ type: "error", stage: "audio", message: `resample failed: ${errText(err)}` });
      return;
    }

    const r = s.segmenter.feed(mono);
    if (r.started) {
      s.openUtteranceId = ++s.lastUtteranceId;
      s.lastInterimAt = -Infinity; // fresh throttle window per utterance
    }
    if (r.dropped) {
      post({
        type: "error",
        stage: "audio",
        message: `discarded ${Math.round(r.dropped.endMs - r.dropped.startMs)}ms blip (below minUtteranceMs)`,
      });
    }
    if (r.ended) {
      s.openUtteranceId = null; // any in-flight interim for it is now stale
      // Serialize: transcribe → post final, in utterance order.
      const u = r.ended;
      s.queue = s.queue.then(async () => {
        const result = await decode(s, u.samples);
        post({
          type: "final",
          text: result.text,
          confidence: result.confidence,
          language: s.language,
          startMs: Math.round(u.startMs),
          endMs: Math.round(u.endMs),
          reason: u.reason,
        });
      });
      return;
    }
    maybeInterim(s);
  }

  function stop(): void {
    const s = session;
    if (!s) {
      post({ type: "stopped" }); // stop without start: already idle
      return;
    }
    s.stopping = true;
    s.openUtteranceId = null;
    const tail = s.segmenter.flush(); // explicit user stop ⇒ short finals kept
    if (tail) {
      const u = tail;
      s.queue = s.queue.then(async () => {
        const result = await decode(s, u.samples);
        post({
          type: "final",
          text: result.text,
          confidence: result.confidence,
          language: s.language,
          startMs: Math.round(u.startMs),
          endMs: Math.round(u.endMs),
          reason: u.reason,
        });
      });
    }
    // `stopped` only after every queued final has posted.
    void s.queue.then(() => post({ type: "stopped" }));
  }

  // ─── decode paths ───────────────────────────────────────────────────────────

  /**
   * Throttled trailing-buffer preview: at most one interim decode in flight,
   * a minimum gap between attempts, a minimum utterance length before the
   * first. If the utterance closes while decoding, the interim is dropped on
   * arrival — the final supersedes it (drop-oldest backpressure: the WASM RTF
   * is the bottleneck, so a stale preview is worthless).
   */
  function maybeInterim(s: Session): void {
    if (!s.interimEnabled || s.stopping || s.interimInFlight) return;
    const current = s.segmenter.currentUtterance();
    if (!current) return;
    const utteranceMs = current.endMs - current.startMs;
    const sinceLast = deps.now() - s.lastInterimAt;
    const due =
      utteranceMs >= FIRST_INTERIM_MS &&
      (s.lastInterimAt === -Infinity || sinceLast >= INTERIM_INTERVAL_MS);
    if (!due || utteranceMs < MIN_INTERIM_UTTERANCE_MS) return;

    const utteranceId = s.openUtteranceId;
    const startMs = Math.round(current.startMs);
    const endMs = Math.round(current.endMs);
    s.interimInFlight = true;
    s.lastInterimAt = deps.now();
    void decode(s, current.samples)
      .then((result) => {
        if (session !== s || s.openUtteranceId !== utteranceId) return; // superseded
        if (!result.text) return; // gate-tripped previews say nothing
        post({ type: "interim", text: result.text, confidence: result.confidence, startMs, endMs });
      })
      .catch(() => undefined) // decode() already posted the engine error
      .finally(() => {
        s.interimInFlight = false;
      });
  }

  /**
   * One decode through the injected engine: utterance samples → WAV PCM16 →
   * engine (the PCM16 roundtrip is ~96 dB quantization — nothing to ASR —
   * and it reuses the engine's whole gate + telemetry path unchanged).
   */
  async function decode(s: Session, samples: Float32Array): Promise<SttResult> {
    try {
      return await engine.transcribe(encodeWavPcm16(samples, MODEL_SAMPLE_RATE), {
        language: s.language,
      });
    } catch (err) {
      post({ type: "error", stage: "engine", message: `transcribe failed: ${errText(err)}` });
      return { text: "" };
    }
  }

  function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── self-installing shell (only inside a real worker scope) ─────────────────

interface WorkerScope {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

/** True only inside a DedicatedWorkerGlobalScope (not Node, not the main thread). */
function isWorkerScope(): boolean {
  const g = globalThis as unknown as { self?: unknown; window?: unknown };
  return typeof g.self !== "undefined" && g.self !== g.window;
}

/**
 * The shell's engine: a STABLE view whose backing engine is rebuilt per
 * `start` message (per-session options: language, keepDiacritics,
 * maxLoadedModels, debug). The core captures the view once; every
 * transcribe/warm awaits whatever engine is current — chunks arriving during
 * model load queue on the construction instead of racing it. Restarting
 * without stop() disposes the previous engine mid-session and loses its
 * un-decoded tail; stop-then-restart drains first and loses nothing.
 */
function shellEngine(): { view: DictationEngine; rebuild(startMsg: DictationStart): void } {
  let current: Promise<DictationEngine> = Promise.reject(new Error("no session started"));
  const build = (msg: DictationStart) =>
    import("../../engines/moonshine/index.js").then(
      (m) =>
        m.createMoonshineSttEngine({
          language: msg.language,
          keepDiacritics: msg.keepDiacritics,
          debug: msg.debug,
          maxLoadedModels: msg.maxLoadedModels,
          // Self-hosted binaries from HF /resolve/, decode-table sidecars from
          // our own origin — the same policy as the parse pipeline's engine.
          modelOrigin: m.createMoonshineModelOrigin(),
        }) as DictationEngine,
    );
  return {
    view: {
      async transcribe(bytes, opts) {
        return (await current).transcribe(bytes, opts);
      },
      async warm(language) {
        await (await current).warm?.(language);
      },
      dispose() {
        void current.then((e) => e.dispose?.()).catch(() => undefined);
      },
    },
    rebuild(msg: DictationStart): void {
      void current.then((e) => e.dispose?.()).catch(() => undefined);
      current = build(msg);
    },
  };
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as WorkerScope;
  const shell = shellEngine();
  const core = createDictationCore({
    engine: shell.view,
    post: (m) => scope.postMessage(m),
    now: () => performance.now(),
  });
  scope.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data;
    if (isDictationStart(msg)) shell.rebuild(msg);
    core.onMessage(msg as DictationInbound);
  };
}
