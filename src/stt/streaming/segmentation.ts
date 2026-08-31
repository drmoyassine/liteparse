/**
 * Utterance segmentation for live dictation — a pure RMS voice-activity
 * detector, no ML, no state threading.
 *
 * The D1 dictation pipeline (VAD-chunked batch): the capture worklet frames
 * the mic, the dictation worker resamples to 16 kHz, and THIS module decides
 * where utterances start and end. A finalized utterance is transcribed by the
 * batch/streaming model whole; interims come from the trailing buffer (the
 * D2 incremental decoder is the upgrade path — see ROADMAP Track 3 v1b).
 *
 * Energy-based VAD is deliberately simple: dictation input is a near-mic
 * voice clip, not a conference room. Speech ≥ threshold opens an utterance;
 * `hangoverMs` of continuous quiet closes it; blips shorter than
 * `minUtteranceMs` are dropped (clicks, breaths); `maxUtteranceMs` force-
 * finalizes so one runaway utterance can't blow the decode budget (the
 * models cap at 194–512 tokens anyway).
 *
 * Pure and synchronous — every behavior is unit-testable with synthetic RMS
 * envelopes (test/segmentation.test.ts).
 */

/** Default threshold: an open mic in a quiet room idles well below this. */
export const DEFAULT_VAD_RMS = 0.01;

export interface SegmentationOptions {
  /** Chunk RMS ≥ this counts as speech (default {@link DEFAULT_VAD_RMS}). */
  rmsThreshold: number;
  /** Continuous quiet that CLOSES an utterance (default 480 ms). */
  hangoverMs: number;
  /** Closed-utterance blips shorter than this are dropped (default 240 ms). */
  minUtteranceMs: number;
  /** Force-finalize at this length (default 15 000 ms — the decode budget). */
  maxUtteranceMs: number;
  /**
   * Audio kept BEFORE the opening speech chunk, prepended to the utterance so
   * the first phoneme isn't clipped by the detector's reaction time
   * (default 160 ms ≈ one syllable onset).
   */
  prerollMs: number;
}

const DEFAULTS: SegmentationOptions = {
  rmsThreshold: DEFAULT_VAD_RMS,
  hangoverMs: 480,
  minUtteranceMs: 240,
  maxUtteranceMs: 15_000,
  prerollMs: 160,
};

/** Why an utterance ended. `flush` = explicit stop()/drain by the caller. */
export type UtteranceEndReason = "hangover" | "max-length" | "flush";

export interface Utterance {
  /** The whole utterance incl. preroll and the hangover tail, 16 kHz mono. */
  samples: Float32Array;
  /** Session-relative offsets (ms since dictation start). */
  startMs: number;
  endMs: number;
  reason: UtteranceEndReason;
}

export interface FeedResult {
  /** An utterance OPENED on this chunk (the UI can show "listening…"). */
  started: boolean;
  /** An utterance CLOSED on this chunk (null while speech continues). */
  ended: Utterance | null;
  /** A blip was closed and discarded (telemetry only). */
  dropped: { startMs: number; endMs: number } | null;
}

/**
 * Feed 16 kHz mono chunks; get utterance boundaries. One instance per
 * dictation session — the session clock is the sample count this segmenter
 * has consumed.
 */
export class RmsSegmenter {
  private readonly opts: SegmentationOptions;
  /** Session clock in samples (16 kHz). */
  private totalSamples = 0;
  private open = false;
  private utteranceStartSample = 0;
  private silenceSamples = 0;
  private chunks: Float32Array[] = [];
  private utteranceSamples = 0;
  /** SPEECH samples in the open utterance (the blip filter's measure — the
   *  hangover tail is quiet by definition and must not rescue a click). */
  private speechSamples = 0;
  /** Rolling pre-roll ring, kept while closed. */
  private preroll = new Float32Array(0);

  constructor(opts: Partial<SegmentationOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** True between an opening chunk and the utterance's end. */
  get isOpen(): boolean {
    return this.open;
  }

  /** Session time (ms) of everything consumed so far. */
  get sessionMs(): number {
    return (this.totalSamples / 16000) * 1000;
  }

  /**
   * The in-progress utterance (a COPY — the internal buffer keeps growing) or
   * null while closed. The worker feeds this to the engine for interims.
   */
  currentUtterance(): Utterance | null {
    if (!this.open) return null;
    return {
      samples: concatChunks(this.chunks, this.utteranceSamples),
      startMs: (this.utteranceStartSample / 16000) * 1000,
      endMs: this.sessionMs,
      reason: "hangover", // interim — the end reason isn't decided yet
    };
  }

  feed(chunk: Float32Array): FeedResult {
    const result: FeedResult = { started: false, ended: null, dropped: null };
    if (!chunk.length) return result;

    const speech = rmsOf(chunk) >= this.opts.rmsThreshold;
    this.totalSamples += chunk.length;

    if (!this.open) {
      if (!speech) {
        // Stay closed; remember the tail as pre-roll for the next opening.
        this.pushPreroll(chunk);
        return result;
      }
      this.open = true;
      result.started = true;
      // The span covers the audio the utterance WILL contain — the preroll
      // rides in front of the speech onset, so the start backs up over it.
      this.utteranceStartSample = this.totalSamples - chunk.length - this.preroll.length;
      this.silenceSamples = 0;
      this.chunks = [this.preroll.slice(), chunk];
      this.utteranceSamples = this.preroll.length + chunk.length;
      this.speechSamples = chunk.length;
      this.preroll = new Float32Array(0);
      return result;
    }

    // Open: accumulate; count consecutive quiet samples toward the hangover.
    this.chunks.push(chunk);
    this.utteranceSamples += chunk.length;
    if (speech) this.speechSamples += chunk.length;
    this.silenceSamples = speech ? 0 : this.silenceSamples + chunk.length;

    const utteranceMs = (this.utteranceSamples / 16000) * 1000;
    const hangoverMs = (this.silenceSamples / 16000) * 1000;
    if (hangoverMs >= this.opts.hangoverMs) {
      const { utterance, dropped } = this.close("hangover");
      result.ended = utterance;
      result.dropped = dropped;
    } else if (utteranceMs >= this.opts.maxUtteranceMs) {
      result.ended = this.close("max-length").utterance;
    }
    return result;
  }

  /**
   * End the open utterance NOW (stop/drain). Unlike a hangover close, a flush
   * is the user's explicit "done" — a short final word is returned, not
   * dropped by {@link SegmentationOptions.minUtteranceMs}. Null when closed.
   */
  flush(): Utterance | null {
    if (!this.open) return null;
    return this.close("flush").utterance;
  }

  /** Close the open utterance: snapshot the samples, then reset the state. */
  private close(
    reason: UtteranceEndReason,
  ): { utterance: Utterance | null; dropped: { startMs: number; endMs: number } | null } {
    const startMs = (this.utteranceStartSample / 16000) * 1000;
    const endMs = this.sessionMs;
    const samples = concatChunks(this.chunks, this.utteranceSamples);
    const speechMs = (this.speechSamples / 16000) * 1000;

    this.open = false;
    this.silenceSamples = 0;
    this.chunks = [];
    this.utteranceSamples = 0;
    this.speechSamples = 0;

    if (reason !== "flush" && speechMs < this.opts.minUtteranceMs) {
      return { utterance: null, dropped: { startMs, endMs } };
    }
    return { utterance: { samples, startMs, endMs, reason }, dropped: null };
  }

  private pushPreroll(chunk: Float32Array): void {
    const cap = Math.ceil((this.opts.prerollMs / 1000) * 16000);
    if (cap <= 0) return;
    const merged = new Float32Array(this.preroll.length + chunk.length);
    merged.set(this.preroll);
    merged.set(chunk, this.preroll.length);
    this.preroll = merged.length > cap ? merged.subarray(merged.length - cap) : merged;
  }
}

function concatChunks(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function rmsOf(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
  return Math.sqrt(sum / chunk.length);
}
