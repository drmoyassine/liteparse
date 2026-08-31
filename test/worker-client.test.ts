/**
 * Tests for src/worker/worker-client.ts — job correlation, progress, result,
 * error, timeout, abort, and crash handling — against an in-process fake worker.
 */
import { describe, expect, it } from "vitest";
import { createWorkerOcrClient } from "../src/worker/worker-client.js";
import type { WorkerLike } from "../src/worker/worker-client.js";
import type { WorkerOutbound } from "../src/worker/protocol.js";
import type { ParsedDocument } from "../src/types.js";
import type { DocumentProfile, RouteDecision } from "../src/router/types.js";

// ─── fake worker ─────────────────────────────────────────────────────────────

interface PostedMessage {
  message: unknown;
  transfer?: Transferable[];
}

class FakeWorker implements WorkerLike {
  posted: PostedMessage[] = [];
  terminated = false;
  private readonly listeners: Map<string, Array<(ev: { data?: unknown }) => void>> = new Map();

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: unknown }) => void,
  ): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker posting a message to the main thread. */
  emit(outbound: WorkerOutbound): void {
    const ls = this.listeners.get("message") ?? [];
    for (const l of ls) l({ data: outbound });
  }
  /** Simulate a worker crash / unhandled error. */
  crash(): void {
    const ls = this.listeners.get("error") ?? [];
    for (const l of ls) l({});
  }

  /** The correlation id of the last posted parse request. */
  get lastParseId(): number {
    const last = this.posted[this.posted.length - 1];
    return (last?.message as { id?: number })?.id ?? -1;
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function profile(): DocumentProfile {
  return { kind: "image", pages: 1, scanned: null, script: "latin", bytes: 10 };
}
function route(): RouteDecision {
  return {
    reason: "image → browser rapidocr",
    strategies: [{ engine: "rapidocr", location: "browser", script: "latin", reason: "primary" }],
  };
}
function document(text = "hello"): ParsedDocument {
  return {
    text,
    source: "ocr",
    pages: [{ index: 0, text, source: "ocr" }],
    warnings: [],
    kind: "image",
    meta: {
      pagesProcessed: 1,
      totalPages: 1,
      nativePages: 0,
      ocrPages: 1,
      vlmPages: 0,
      sttPages: 0,
      truncated: false,
      chars: text.length,
    },
  };
}
function input() {
  return { bytes: new Uint8Array([1, 2, 3, 4]), filename: "scan.png", profile: profile(), route: route() };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("createWorkerOcrClient", () => {
  it("posts a parse request with a transferable buffer and an assigned id", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const p = client.parse(input());

    const req = fake.posted[0]?.message as {
      type: string;
      id: number;
      bytes: ArrayBuffer;
      filename?: string;
    };
    expect(req.type).toBe("parse");
    expect(req.id).toBe(1);
    expect(req.filename).toBe("scan.png");
    expect(req.bytes).toBeInstanceOf(ArrayBuffer);
    // the buffer was transferred, not copied
    expect(fake.posted[0]?.transfer?.[0]).toBe(req.bytes);

    fake.emit({ type: "result", id: req.id, document: document() });
    await p;
    client.terminate();
  });

  it("fires onProgress in order then resolves with the result", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const seen: string[] = [];
    const id = fake.lastParseId; // before parse this is -1; grab after

    const p = client.parse(input(), {
      onProgress: (e) => seen.push(`${e.stage}:${e.pageIndex}`),
    });
    const reqId = fake.lastParseId;

    fake.emit({ type: "progress", id: reqId, pageIndex: 0, totalPages: 2, stage: "rapidocr", engine: "rapidocr" });
    fake.emit({ type: "progress", id: reqId, pageIndex: 1, totalPages: 2, stage: "rapidocr", engine: "rapidocr" });
    fake.emit({ type: "result", id: reqId, document: document("page text"), engine: "rapidocr" });

    const result = await p;
    expect(seen).toEqual(["rapidocr:0", "rapidocr:1"]);
    expect(result.document.text).toBe("page text");
    expect(result.engine).toBe("rapidocr");
    void id;
  });

  it("rejects when the worker posts an error event", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const p = client.parse(input());
    const reqId = fake.lastParseId;

    fake.emit({ type: "error", id: reqId, message: "all strategies exhausted", stage: "vlm" });

    await expect(p).rejects.toThrow("all strategies exhausted");
  });

  it("rejects all pending jobs when the worker crashes", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const p1 = client.parse(input());
    const p2 = client.parse(input());

    fake.crash();

    await expect(p1).rejects.toThrow("worker error");
    await expect(p2).rejects.toThrow("worker error");
  });

  it("times out and posts a cancel when no result arrives", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake, timeoutMs: 40 });
    const p = client.parse(input());

    await expect(p).rejects.toThrow(/timed out after 40ms/);
    // a cancel was posted for this job
    const cancel = fake.posted.some(
      (m) => (m.message as { type: string }).type === "cancel",
    );
    expect(cancel).toBe(true);
  });

  it("aborts: posts a cancel and rejects with an AbortError", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const ac = new AbortController();
    const p = client.parse(input(), { signal: ac.signal });
    const reqId = fake.lastParseId;

    ac.abort();

    await expect(p).rejects.toSatisfy((err: unknown) => (err as Error).name === "AbortError");
    const cancel = fake.posted.find(
      (m) => (m.message as { type: string; id?: number }).type === "cancel",
    );
    expect((cancel?.message as { id?: number }).id).toBe(reqId);
  });

  it("rejects immediately (without posting) when the signal is already aborted", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const ac = new AbortController();
    ac.abort();

    await expect(client.parse(input(), { signal: ac.signal })).rejects.toSatisfy(
      (err: unknown) => (err as Error).name === "AbortError",
    );
    expect(fake.posted).toHaveLength(0);
  });

  it("cancel() posts a CancelRequest for an in-flight job", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const p = client.parse(input());
    const reqId = fake.lastParseId;

    client.cancel(reqId);
    const cancel = fake.posted.find(
      (m) => (m.message as { type: string }).type === "cancel",
    );
    expect((cancel?.message as { id?: number }).id).toBe(reqId);

    // still resolves if the worker later posts a result (settle is idempotent)
    fake.emit({ type: "result", id: reqId, document: document() });
    await p;
  });

  it("terminate() rejects pending jobs, tears down the worker, and is idempotent", async () => {
    const fake = new FakeWorker();
    const client = createWorkerOcrClient({ worker: fake });
    const p = client.parse(input());

    client.terminate();
    await expect(p).rejects.toThrow("worker terminated");
    expect(fake.terminated).toBe(true);
    // a second terminate must not throw / double-reject
    expect(() => client.terminate()).not.toThrow();
  });
});
