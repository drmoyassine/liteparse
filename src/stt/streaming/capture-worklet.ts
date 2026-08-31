/**
 * Capture AudioWorkletProcessor for live dictation — dependency-free by
 * contract: this file is shipped as its own entry (`liteparse/stt/worklet`)
 * and loaded with `audioWorklet.addModule(url)`, so it imports NOTHING and
 * inlines its own scope declarations (the AudioWorkletGlobalScope globals are
 * not reliably in TS's DOM lib).
 *
 * What it does per render quantum: mix all input channels to mono, append to
 * a ring buffer, and post a frame whenever `frameMs` (default 100 — VAD
 * granularity, not the model's chunk size) has accumulated. Frames are at the
 * AudioContext's NATIVE rate; resampling to 16 kHz happens in the dictation
 * worker via shared/audio.ts's windowed-sinc resampler — quality-critical DSP
 * stays in unit-tested code, and the worklet stays trivial (linear
 * downsampling in the worklet would alias speech energy above 8 kHz back
 * into the band on 44.1/48 kHz contexts).
 *
 * Register: `new AudioWorkletNode(ctx, "liteparse-capture", { numberOfOutputs: 0 })`.
 * Posts `{ type: "frame", samples: Float32Array }` on its MessagePort.
 */

interface WorkletScope {
  readonly sampleRate: number;
  AudioWorkletProcessor: new (options?: { processorOptions?: unknown }) => { readonly port: MessagePort };
  registerProcessor: (name: string, ctor: new (options?: { processorOptions?: unknown }) => unknown) => void;
}

const scope = globalThis as unknown as WorkletScope;

const PROCESSOR_NAME = "liteparse-capture";
const DEFAULT_FRAME_MS = 100;

class CaptureProcessor extends scope.AudioWorkletProcessor {
  /** Whole frames this processor has emitted (monotonic, for diagnostics). */
  private frameIndex = 0;
  private readonly frameSamples: number;
  /** Pending mono samples below one frame. */
  private buffer = new Float32Array(0);

  constructor(options?: { processorOptions?: { frameMs?: number } }) {
    super(options);
    const frameMs = options?.processorOptions?.frameMs ?? DEFAULT_FRAME_MS;
    this.frameSamples = Math.max(
      128, // one render quantum — never emit more often than we render
      Math.round((scope.sampleRate * frameMs) / 1000),
    );
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true; // no source connected yet; keep the processor alive
    }

    // Mono mixdown (channel average — the same policy as shared/audio.ts).
    const channels = input;
    const len = channels[0]!.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      for (let i = 0; i < len; i++) mono[i] = mono[i]! + ch[i]! / channels.length;
    }

    // Accumulate; emit every complete frame (the remainder carries over).
    const merged = new Float32Array(this.buffer.length + mono.length);
    merged.set(this.buffer);
    merged.set(mono, this.buffer.length);
    let at = 0;
    while (at + this.frameSamples <= merged.length) {
      const frame = merged.subarray(at, at + this.frameSamples).slice();
      this.port.postMessage({ type: "frame", index: this.frameIndex++, samples: frame });
      at += this.frameSamples;
    }
    this.buffer = merged.subarray(at).slice();
    return true; // keep the processor registered for the graph's lifetime
  }

  // `port` is inherited from AudioWorkletProcessor (declared in WorkletScope's
  // minimal base type) — do NOT redeclare it: a field initializer would run
  // after super() and shadow the real MessagePort with a stub.
}

scope.registerProcessor(PROCESSOR_NAME, CaptureProcessor as new (options?: { processorOptions?: unknown }) => unknown);

// Side-effect-only entry (addModule just evaluates this file) — the empty
// export only marks it a module for TypeScript consumers/tests.
export {};
