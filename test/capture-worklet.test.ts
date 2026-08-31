import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The capture worklet executes inside AudioWorkletGlobalScope, where no test
 * runner lives — so the test REBUILDS that scope on globalThis (sampleRate,
 * AudioWorkletProcessor base, registerProcessor capture), imports the module
 * fresh, and drives the registered processor's `process()` with synthetic
 * render quanta (128 samples, as the WebAudio spec renders). Everything under
 * test is the worklet's own arithmetic: mono mixdown, exact-frame emission,
 * remainder carry-over.
 */

interface Port {
  posted: { type?: string; index?: number; samples?: Float32Array }[];
  postMessage(message: { type?: string; index?: number; samples?: Float32Array }): void;
}
interface Registered {
  name: string;
  ctor: new (options?: { processorOptions?: unknown }) => { port: Port; process(inputs: Float32Array[][]): boolean };
}

const QUANTUM = 128; // WebAudio render quantum

let restore: (() => void) | null = null;

/** Install a fake worklet scope and import the module inside it. */
async function loadWorklet(sampleRate: number): Promise<{ registered: Registered[]; Processor: Registered["ctor"] }> {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    sampleRate: g.sampleRate,
    AudioWorkletProcessor: g.AudioWorkletProcessor,
    registerProcessor: g.registerProcessor,
  };

  const registered: Registered[] = [];
  class AudioWorkletProcessor {
    port: Port = {
      posted: [],
      // The real scope's MessagePort; the capture posts land in `posted`.
      postMessage(message: { type?: string; index?: number; samples?: Float32Array }) {
        this.posted.push(message);
      },
    };
  }
  g.sampleRate = sampleRate;
  g.AudioWorkletProcessor = AudioWorkletProcessor;
  g.registerProcessor = (name: string, ctor: Registered["ctor"]) => registered.push({ name, ctor });

  restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };

  vi.resetModules();
  await import("../src/stt/streaming/capture-worklet.js");
  const Processor = registered[0]!.ctor;
  return { registered, Processor };
}

afterEach(() => {
  restore?.();
  restore = null;
  vi.resetModules();
});

/** A synthetic render quantum with per-channel constant levels. */
const quantum = (levels: number[]): Float32Array[] =>
  levels.map((level) => {
    const ch = new Float32Array(QUANTUM);
    if (level !== 0) ch.fill(level);
    return ch;
  });

describe("capture worklet", () => {
  it("registers as liteparse-capture on a dependency-free scope base", async () => {
    const { registered } = await loadWorklet(48_000);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("liteparse-capture");
  });

  it("mixes channels to mono (average) and emits exact-frame slices at the native rate", async () => {
    const { Processor } = await loadWorklet(48_000); // 100 ms → 4800 samples
    const p = new Processor();
    // 38 quanta = 4864 samples → one 4800-sample frame, 64 carried over.
    for (let i = 0; i < 38; i++) p.process([quantum([0.4, 0.2])]);

    expect(p.port.posted).toHaveLength(1);
    const frame = p.port.posted[0]!;
    expect(frame).toMatchObject({ type: "frame", index: 0 });
    expect(frame.samples).toHaveLength(4800);
    expect(frame.samples![0]).toBeCloseTo(0.3, 6); // (0.4 + 0.2) / 2
    expect(frame.samples![4799]).toBeCloseTo(0.3, 6);
  });

  it("carries the remainder across frames with no sample lost or duplicated", async () => {
    const { Processor } = await loadWorklet(48_000);
    const p = new Processor();
    // 75 quanta = 9600 samples → frames at 4800 and 9600, remainder 0.
    for (let i = 0; i < 38; i++) p.process([quantum([1])]);
    for (let i = 0; i < 37; i++) p.process([quantum([2])]);

    const posted = p.port.posted;
    expect(posted).toHaveLength(2);
    expect(posted[0]!.samples!.every((s) => s === 1)).toBe(true);
    expect(posted[1]!.samples![0]).toBe(1); // the 37th quantum's tail…
    expect(posted[1]!.samples!.some((s) => s === 2)).toBe(true); // …then the new level
    expect(posted[1]!.index).toBe(1);
  });

  it("honors processorOptions.frameMs", async () => {
    const { Processor } = await loadWorklet(16_000); // frameMs 50 → 800 samples
    const p = new Processor({ processorOptions: { frameMs: 50 } });
    for (let i = 0; i < 7; i++) p.process([quantum([0.5])]); // 896 samples → 1 frame
    expect(p.port.posted).toHaveLength(1);
    expect(p.port.posted[0]!.samples).toHaveLength(800);
  });

  it("keeps the processor alive on empty input", async () => {
    const { Processor } = await loadWorklet(48_000);
    const p = new Processor();
    expect(p.process([])).toBe(true);
    expect(p.process([[]])).toBe(true);
    expect(p.port.posted).toHaveLength(0);
  });
});
