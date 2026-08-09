/**
 * Main-thread client for the Intelligent Document Router's Web Worker.
 *
 * `createWorkerOcrClient` wraps a `Worker` (spawning it from a URL, or accepting
 * an already-created instance) and exposes a promise-based `parse()` plus
 * `onProgress` callbacks, `cancel()`, and `terminate()`. It is the only surface the
 * UI talks to; it owns job correlation, timeout, abort, and crash propagation.
 *
 * The worker ↔ main protocol is locked in `protocol.ts`. This client never
 * interprets document bytes — it transfers them (`postMessage(msg, [bytes])`) and
 * resolves with whatever `ParsedDocument` the worker posts back.
 *
 * See ARCHITECTURE.md → Web Worker Architecture, ROADMAP.md → Phase 2 (A9).
 */
import type {
  CancelRequest,
  ErrorEvent,
  JobId,
  ParseRequest,
  ProgressEvent,
  WorkerOutbound,
} from "./protocol.js";
import { isError, isProgress, isResult } from "./protocol.js";
import type { DocumentProfile, ExtractionEngine, RouteDecision } from "../router/types.js";
import type { ParsedDocument } from "../types.js";

/** A Worker-like surface: the real `Worker`, or a stub in tests. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: unknown }) => void,
  ): void;
  terminate(): void;
}

export interface WorkerOcrClientOptions {
  /** An existing Worker, or a URL string to spawn one from. */
  worker: WorkerLike | string;
  /** Per-job timeout. Default 120_000ms. `<= 0` disables. */
  timeoutMs?: number;
}

/** The payload the caller supplies; the client assigns the correlation id. */
export interface ParseInput {
  /** Document bytes. The underlying buffer is transferred (not copied). */
  bytes: Uint8Array;
  filename?: string;
  profile: DocumentProfile;
  route: RouteDecision;
}

export interface ParseHandlers {
  onProgress?: (e: ProgressEvent) => void;
  /** Abort this parse. Posts a cancel + rejects the promise with an AbortError. */
  signal?: AbortSignal;
}

export interface ParseResult {
  document: ParsedDocument;
  engine?: ExtractionEngine;
}

export interface WorkerOcrClient {
  /** Start a parse job. Resolves with the worker's result; rejects on error/timeout/abort. */
  parse(input: ParseInput, handlers?: ParseHandlers): Promise<ParseResult>;
  /** Cancel an in-flight job by id (posts a CancelRequest; the worker ends the job). */
  cancel(id: JobId): void;
  /** Tear down the worker and reject all pending jobs. */
  terminate(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingJob {
  resolve: (r: ParseResult) => void;
  reject: (e: Error) => void;
  onProgress?: (e: ProgressEvent) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** Abort signal for this job, if any (detached on settle). */
  signal?: AbortSignal;
  /** The abort listener registered on `signal` (detached on settle). */
  onAbort?: () => void;
}

function makeAbortError(): Error {
  // Prefer a real AbortError when DOMException is available; fall back to a plain Error.
  if (typeof DOMException !== "undefined") {
    return new DOMException("parse aborted", "AbortError");
  }
  const e = new Error("parse aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Create a worker client. If `opts.worker` is a string, a new `Worker` is spawned
 * from it; otherwise the provided {@link WorkerLike} is used as-is (this is how
 * tests inject a stub worker).
 */
export function createWorkerOcrClient(opts: WorkerOcrClientOptions): WorkerOcrClient {
  const worker: WorkerLike =
    typeof opts.worker === "string" ? (new Worker(opts.worker) as unknown as WorkerLike) : opts.worker;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pending = new Map<JobId, PendingJob>();
  let nextId = 1;

  /** Clear timeout + detach the abort listener and drop the job from the map. */
  function finish(id: JobId): void {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (job.timeoutId) clearTimeout(job.timeoutId);
    if (job.signal && job.onAbort) {
      job.signal.removeEventListener("abort", job.onAbort);
    }
  }

  worker.addEventListener("message", (ev: { data?: unknown }) => {
    const msg = ev.data as WorkerOutbound | undefined;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    if (msg.id === undefined || msg.id === null) return;

    if (isProgress(msg)) {
      pending.get(msg.id)?.onProgress?.(msg);
      return;
    }
    if (isResult(msg)) {
      const job = pending.get(msg.id);
      if (!job) return;
      finish(msg.id);
      job.resolve({ document: msg.document, engine: msg.engine });
      return;
    }
    if (isError(msg)) {
      const job = pending.get(msg.id);
      if (!job) return;
      finish(msg.id);
      // The worker posts `{type:"error", message}`. When the worker aborted (its
      // AbortError serialises to message "aborted"), surface it as a recognisable
      // AbortError so callers can tell abort apart from a real failure. (P4 / R2-D.)
      const message = (msg as ErrorEvent).message;
      job.reject(message === "aborted" ? makeAbortError() : new Error(message));
    }
  });

  worker.addEventListener("error", () => {
    // Worker crashed/hard-errored: reject every pending job.
    for (const [id, job] of pending) {
      finish(id);
      job.reject(new Error("worker error"));
    }
  });

  worker.addEventListener("messageerror", () => {
    // Worker posted a message that couldn't be deserialised (non-cloneable /
    // cyclic). The job that produced it will never get a result, so fail every
    // pending job rather than leave any hanging. (P4 / R2-I.)
    for (const [id, job] of pending) {
      finish(id);
      job.reject(new Error("worker message deserialization failed"));
    }
  });

  function postCancel(id: JobId): void {
    const cancel: CancelRequest = { type: "cancel", id };
    worker.postMessage(cancel);
  }

  function parse(input: ParseInput, handlers: ParseHandlers = {}): Promise<ParseResult> {
    return new Promise<ParseResult>((resolve, reject) => {
      const id: JobId = nextId++;

      // Pre-aborted: reject without posting.
      if (handlers.signal?.aborted) {
        reject(makeAbortError());
        return;
      }

      const job: PendingJob = {
        resolve,
        reject,
        onProgress: handlers.onProgress,
        timeoutId:
          timeoutMs > 0
            ? setTimeout(() => {
                if (!pending.has(id)) return;
                postCancel(id);
                finish(id);
                reject(new Error(`parse timed out after ${timeoutMs}ms`));
              }, timeoutMs)
            : null,
      };
      pending.set(id, job);

      // Wire abort: post cancel + reject the promise.
      if (handlers.signal) {
        const onAbort = (): void => {
          if (!pending.has(id)) return;
          postCancel(id);
          finish(id);
          reject(makeAbortError());
        };
        job.signal = handlers.signal;
        job.onAbort = onAbort;
        handlers.signal.addEventListener("abort", onAbort, { once: true });
      }

      const view = input.bytes;
      const isSubarray =
        view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength;
      // Transfer the underlying buffer. When `input.bytes` is a subarray view, copy
      // it first (view.slice()) — otherwise we'd ship + detach the *whole* backing
      // buffer and the worker would reconstruct the wrong byte range. (P4 / R2-G.)
      const owned = isSubarray ? view.slice() : view;
      const request: ParseRequest = {
        type: "parse",
        id,
        bytes: owned.buffer as ArrayBuffer,
        filename: input.filename,
        profile: input.profile,
        route: input.route,
      };
      // Transfer the underlying buffer (zero-copy when not a subarray).
      worker.postMessage(request, [request.bytes]);
    });
  }

  function cancel(id: JobId): void {
    if (!pending.has(id)) return;
    postCancel(id);
  }

  function terminate(): void {
    for (const [id, job] of pending) {
      finish(id);
      job.reject(new Error("worker terminated"));
    }
    worker.terminate();
  }

  return { parse, cancel, terminate };
}
