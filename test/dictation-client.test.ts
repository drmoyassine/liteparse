import { afterEach, describe, expect, it, vi } from "vitest";
import { createDictation } from "../src/stt/streaming/dictation-client.js";
import type { WorkerLike } from "../src/worker/worker-client.js";
import type { DictationOutbound } from "../src/stt/streaming/protocol.js";

/**
 * The dictation main-thread client with EVERY platform piece stubbed on
 * globalThis (the worker-client.test pattern): fake Worker, fake
 * AudioContext/audioWorklet, fake AudioWorkletNode, fake getUserMedia. Pins
 * the wiring the composer relies on: mic-acquisition ownership, frame relay
 * with transfer, protocol event routing, and stop() teardown.
 */

// ── fakes ─────────────────────────────────────────────────────────────────────

type Listener = (ev: { data?: unknown }) => void;

function fakeWorker(autoReady = true) {
  const listeners: Listener[] = [];
  const posted: { message: unknown; transfer?: Transferable[] }[] = [];
  const w = {
    postMessage(message: unknown, transfer?: Transferable[]) {
      posted.push({ message, transfer });
      if (autoReady && (message as { type?: string }).type === "start") {
        emit({ type: "ready", language: (message as { language?: "en" }).language ?? "en" });
      }
      if (autoReady && (message as { type?: string }).type === "stop") {
        emit({ type: "stopped" });
      }
    },
    addEventListener(_type: "message", listener: Listener) {
      listeners.push(listener);
    },
    terminate: vi.fn(),
  };
  function emit(message: DictationOutbound) {
    for (const l of listeners) l({ data: message });
  }
  return { worker: w as unknown as WorkerLike, posted, emit };
}

/** Every AudioWorkletNode the fake ctor created (tests drive their ports). */
const createdNodes: FakeAudioWorkletNode[] = [];

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = 48_000;
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  close = vi.fn(async () => undefined);
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(_stream: unknown) {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}

class FakeAudioWorkletNode {
  readonly port = { onmessage: null as ((ev: { data?: unknown }) => void) | null };
  disconnect = vi.fn();
  constructor() {
    createdNodes.push(this);
  }
}

/** A duck-typed MediaStream whose tracks we can observe being stopped. */
const fakeStream = () => {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] }, stop };
};

let getUserMedia: ReturnType<typeof vi.fn>;
let navigatorDescriptor: PropertyDescriptor | undefined;
let originals: Record<string, unknown> = {};

/** Stub the audio platform. Returns the stream getUserMedia will hand out. */
function installAudioGlobals() {
  const g = globalThis as Record<string, unknown>;
  originals = {
    AudioContext: g.AudioContext,
    webkitAudioContext: g.webkitAudioContext,
    AudioWorkletNode: g.AudioWorkletNode,
  };
  g.AudioContext = FakeAudioContext;
  g.AudioWorkletNode = FakeAudioWorkletNode;

  const owned = fakeStream();
  getUserMedia = vi.fn(async () => owned.stream as unknown as MediaStream);
  // navigator is a getter on Node's global — replace by descriptor, restore the
  // same way (plain assignment would throw against an accessor).
  navigatorDescriptor = Object.getOwnPropertyDescriptor(g, "navigator");
  Object.defineProperty(g, "navigator", {
    value: { ...(g.navigator as object), mediaDevices: { getUserMedia } },
    writable: true,
    configurable: true,
  });
  return { ownedStream: owned.stream as unknown as MediaStream, ownedStop: owned.stop };
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(originals)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  if (navigatorDescriptor) Object.defineProperty(g, "navigator", navigatorDescriptor);
  else delete g.navigator;
  navigatorDescriptor = undefined;
  originals = {};
  createdNodes.length = 0;
  FakeAudioContext.instances.length = 0;
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createDictation — start", () => {
  it("acquires the mic by deviceId, loads the worklet, wires the graph, and awaits ready", async () => {
    installAudioGlobals();
    const { worker, posted } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/assets/worklet.js", language: "ar" });
    await dictation.start({ deviceId: "mic-1" });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "mic-1" } } });
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith("/assets/worklet.js");
    const start = posted.find((p) => (p.message as { type?: string }).type === "start")!;
    expect(start.message).toMatchObject({ type: "start", language: "ar" });
    void ctx;
  });

  it("uses an injected MediaStream as-is (no getUserMedia)", async () => {
    installAudioGlobals();
    const { worker } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    const { stream } = fakeStream();
    await dictation.start(stream as unknown as MediaStream);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("rejects a second start while active", async () => {
    installAudioGlobals();
    const { worker } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    const { stream } = fakeStream();
    await dictation.start(stream as unknown as MediaStream);
    await expect(dictation.start(stream as unknown as MediaStream)).rejects.toThrow(/already started/);
  });

  it("rejects when the worker never posts ready (wrong worker script)", async () => {
    installAudioGlobals();
    vi.useFakeTimers();
    try {
      const { worker } = fakeWorker(false); // no auto-ready
      const dictation = createDictation({ worker, workletUrl: "/w.js" });
      const { stream } = fakeStream();
      const pending = dictation.start(stream as unknown as MediaStream);
      const assertion = expect(pending).rejects.toThrow(/did not post ready/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      // The half-built graph is unwound: the context got closed.
      expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createDictation — frame relay", () => {
  it("relays worklet frames as chunk messages at the context rate, transferring the buffer", async () => {
    installAudioGlobals();
    const { worker, posted } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    const { stream } = fakeStream();
    await dictation.start(stream as unknown as MediaStream);

    const samples = new Float32Array(160);
    createdNodes[0]!.port.onmessage!({ data: { type: "frame", samples } });
    const relay = posted.find((p) => (p.message as { type?: string }).type === "chunk")!;
    expect(relay.message).toMatchObject({ type: "chunk", sampleRate: 48_000 });
    expect((relay.message as { samples: Float32Array }).samples).toBe(samples);
    expect(relay.transfer).toContain(samples.buffer);

    // Non-frame messages (and frames without Float32 samples) are ignored.
    createdNodes[0]!.port.onmessage!({ data: { type: "something-else" } });
    createdNodes[0]!.port.onmessage!({ data: { type: "frame", samples: "not-a-buffer" } });
    expect(posted.filter((p) => (p.message as { type?: string }).type === "chunk")).toHaveLength(1);
  });
});

describe("createDictation — events", () => {
  it("routes interim/final/error to the handlers", async () => {
    installAudioGlobals();
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const onError = vi.fn();
    const { worker, emit } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js", onInterim, onFinal, onError });
    const { stream } = fakeStream();
    await dictation.start(stream as unknown as MediaStream);

    emit({ type: "interim", text: "hello", startMs: 0, endMs: 900 });
    emit({ type: "final", text: "hello world", language: "en", startMs: 0, endMs: 1500, reason: "hangover" });
    emit({ type: "error", message: "engine hiccup", stage: "engine" });
    expect(onInterim).toHaveBeenCalledWith(expect.objectContaining({ type: "interim", text: "hello" }));
    expect(onFinal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "final", text: "hello world", reason: "hangover" }),
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ stage: "engine" }));
  });
});

describe("createDictation — stop", () => {
  it("deviceId capture: stops the tracks it acquired, tears down the graph, awaits stopped", async () => {
    const { ownedStop } = installAudioGlobals();
    const { worker } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    await dictation.start({ deviceId: "mic-7" });
    await dictation.stop();

    expect(ownedStop).toHaveBeenCalled(); // we acquired the mic — we release it
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalled();
    expect(createdNodes[0]!.disconnect).toHaveBeenCalled();
  });

  it("injected stream: keeps the caller's tracks running, still closes the context", async () => {
    installAudioGlobals();
    const { worker } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    const { stream, stop } = fakeStream();
    await dictation.start(stream as unknown as MediaStream);
    await dictation.stop();
    expect(stop).not.toHaveBeenCalled(); // caller owns the lifecycle
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalled();
  });

  it("stop without start is a no-op", async () => {
    installAudioGlobals();
    const { worker } = fakeWorker();
    const dictation = createDictation({ worker, workletUrl: "/w.js" });
    await expect(dictation.stop()).resolves.toBeUndefined();
  });
});
