/**
 * Dictation main-thread client — `createDictation({ worker, workletUrl })`.
 *
 * Owns everything platform-side so the composer doesn't touch raw audio APIs:
 * getUserMedia (or an injected MediaStream), the AudioContext + AudioWorklet
 * graph (`liteparse-capture` from `liteparse/stt/worklet`), frame relay into
 * the dictation worker, and the protocol event surface (`onInterim`,
 * `onFinal`, `onError`). The worker is INJECTED (consumers host
 * `liteparse/stt/dictation-worker` — or their own — and keep it across
 * sessions; the client neither spawns nor terminates it).
 *
 * Consumer wiring:
 *
 * ```ts
 * const dictation = createDictation({
 *   worker: new Worker(new URL("liteparse/stt/dictation-worker", import.meta.url), { type: "module" }),
 *   workletUrl: new URL("liteparse/stt/worklet", import.meta.url), // self-hosted, like /ort/
 *   language: "ar",
 *   onFinal: (f) => composer.insert(f.text),
 *   onInterim: (i) => composer.preview(i.text),
 * });
 * await dictation.start({ deviceId }); // or start(myMediaStream)
 * // …
 * await dictation.stop();
 * ```
 */

import type { SttLanguage } from "../../engines/moonshine/shared/models.js";
import type { WorkerLike } from "../../worker/worker-client.js";
import type { SegmentationOptions } from "./segmentation.js";
import type {
  DictationError,
  DictationFinal,
  DictationInterim,
  DictationOutbound,
} from "./protocol.js";
import {
  isDictationError,
  isDictationFinal,
  isDictationInterim,
  isDictationReady,
  isDictationStopped,
} from "./protocol.js";

/** Fail `start()` if the worker never posts ready (wrong worker script, etc.). */
const START_TIMEOUT_MS = 10_000;
/** Fail `stop()` if the worker never confirms (a stuck decode — see worker). */
const STOP_TIMEOUT_MS = 30_000;

export interface DictationHandlers {
  /** Partial transcript of the utterance still being spoken. */
  onInterim?(interim: DictationInterim): void;
  /** Finalized utterance text ("" = the engine gate discarded it). */
  onFinal?(final: DictationFinal): void;
  /** Non-fatal worker-side failures (engine/audio/protocol stage). */
  onError?(error: DictationError): void;
}

export interface DictationConfig extends DictationHandlers {
  /** The dictation worker (hosted by the consumer; never terminated here). */
  worker: WorkerLike;
  /** URL passed to `audioWorklet.addModule` — the `liteparse/stt/worklet` entry. */
  workletUrl: string | URL;
  /** Session language (default "en"). */
  language?: SttLanguage;
  /** Keep Arabic diacritics in finals/interims (default: strip tashkeel). */
  keepDiacritics?: boolean;
  /** Engine telemetry in the worker (default off in dictation). */
  debug?: boolean;
  /** Engine LRU cap (default 2 — see MoonshineSttEngineOptions). */
  maxLoadedModels?: number;
  /** Emit interims (default true). */
  interim?: boolean;
  /** VAD tuning (defaults in streaming/segmentation.ts). */
  vad?: Partial<SegmentationOptions>;
}

export interface Dictation {
  /** Open the mic and begin. Resolves on the worker's `ready`. */
  start(source: MediaStream | { deviceId: string }): Promise<void>;
  /** Close the mic, flush the trailing utterance. Resolves on `stopped`. */
  stop(): Promise<void>;
}

// Minimal structural shapes for the audio graph — everything is reached
// through globalThis casts so tests can stub each piece, and no DOM type
// beyond MediaStream (the public parameter) leaks into the implementation.
interface MicStream {
  getTracks(): { stop(): void }[];
}
interface CaptureNode {
  readonly port: { onmessage: ((ev: { data?: unknown }) => void) | null };
  disconnect(): void;
}
interface AudioSourceNode {
  connect(node: unknown): void;
  disconnect(): void;
}
interface AudioCtx {
  readonly sampleRate: number;
  readonly audioWorklet: { addModule(url: string | URL): Promise<void> };
  createMediaStreamSource(stream: MediaStream): AudioSourceNode;
  close(): Promise<void>;
}

export function createDictation(cfg: DictationConfig): Dictation {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioCtx;
    webkitAudioContext?: new () => AudioCtx;
    AudioWorkletNode?: new (
      ctx: AudioCtx,
      name: string,
      opts?: { numberOfOutputs?: number },
    ) => CaptureNode;
    navigator?: { mediaDevices?: { getUserMedia(c: { audio: unknown }): Promise<MediaStream> } };
  };

  let active = false;
  let readyWaiter: (() => void) | null = null;
  let stoppedWaiter: (() => void) | null = null;
  let teardownAudio: (() => void) | null = null;

  cfg.worker.addEventListener("message", (ev: { data?: unknown }) => {
    const m = ev.data as DictationOutbound | undefined;
    if (!m) return;
    if (isDictationInterim(m)) cfg.onInterim?.(m);
    else if (isDictationFinal(m)) cfg.onFinal?.(m);
    else if (isDictationError(m)) cfg.onError?.(m);
    else if (isDictationReady(m)) readyWaiter?.();
    else if (isDictationStopped(m)) stoppedWaiter?.();
  });

  async function start(source: MediaStream | { deviceId: string }): Promise<void> {
    if (active) throw new Error("dictation already started — stop() first");
    const AC = g.AudioContext ?? g.webkitAudioContext;
    const AWN = g.AudioWorkletNode;
    if (!AC || !AWN) {
      throw new Error("AudioContext/AudioWorklet unavailable — dictation needs a browser context");
    }

    // Mic: a stream with getTracks() is used as-is (the caller owns its
    // lifecycle); anything else is read as { deviceId } and acquired here.
    const maybeStream = source as Partial<MicStream>;
    let stream: MediaStream;
    let ownsStream = false;
    if (typeof maybeStream.getTracks === "function") {
      stream = source as MediaStream;
    } else {
      const md = g.navigator?.mediaDevices;
      if (!md) throw new Error("navigator.mediaDevices unavailable for deviceId capture");
      stream = await md.getUserMedia({
        audio: { deviceId: { exact: (source as { deviceId: string }).deviceId } },
      });
      ownsStream = true;
    }

    const ctx = new AC();
    let node: CaptureNode | null = null;
    let src: AudioSourceNode | null = null;
    const stopTracks = () => {
      if (ownsStream) for (const t of (stream as unknown as MicStream).getTracks()) t.stop();
    };
    const unwind = () => {
      active = false;
      node?.disconnect();
      src?.disconnect();
      stopTracks();
      void ctx.close().catch(() => undefined);
    };

    try {
      await ctx.audioWorklet.addModule(cfg.workletUrl);
      node = new AWN(ctx, "liteparse-capture", { numberOfOutputs: 0 });
      src = ctx.createMediaStreamSource(stream);
      node.port.onmessage = (ev: { data?: unknown }) => {
        const frame = ev.data as { type?: string; samples?: Float32Array } | undefined;
        if (frame?.type !== "frame" || !(frame.samples instanceof Float32Array)) return;
        // Relay at the CONTEXT rate; the worker resamples to 16 kHz (the
        // quality-critical sinc resampler lives there, unit-tested).
        cfg.worker.postMessage(
          { type: "chunk", samples: frame.samples, sampleRate: ctx.sampleRate },
          [frame.samples.buffer],
        );
      };
      src.connect(node);

      active = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          readyWaiter = null;
          reject(new Error(`worker did not post ready within ${START_TIMEOUT_MS}ms`));
        }, START_TIMEOUT_MS);
        readyWaiter = () => {
          clearTimeout(timer);
          readyWaiter = null;
          resolve();
        };
        cfg.worker.postMessage({
          type: "start",
          language: cfg.language,
          keepDiacritics: cfg.keepDiacritics,
          debug: cfg.debug,
          maxLoadedModels: cfg.maxLoadedModels,
          interim: cfg.interim,
          vad: cfg.vad,
        });
      });
    } catch (err) {
      unwind(); // graph is half-built: release everything this call created
      throw err;
    }

    teardownAudio = unwind;
  }

  async function stop(): Promise<void> {
    if (!active) return;
    active = false;
    teardownAudio?.();
    teardownAudio = null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stoppedWaiter = null;
        reject(new Error(`worker did not confirm stop within ${STOP_TIMEOUT_MS}ms`));
      }, STOP_TIMEOUT_MS);
      stoppedWaiter = () => {
        clearTimeout(timer);
        stoppedWaiter = null;
        resolve();
      };
      cfg.worker.postMessage({ type: "stop" });
    });
  }

  return { start, stop };
}
