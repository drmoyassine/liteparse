/**
 * Request-budget primitives: an in-flight semaphore (the VPS is small; runaway
 * concurrent OCR starves every request) and a per-request deadline.
 */

export interface Semaphore {
  /** Try to take a slot. Returns a release fn, or null when at capacity. */
  tryAcquire(): (() => void) | null;
  readonly active: number;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return null;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
    get active() {
      return active;
    },
  };
}

/** Per-request deadline: an AbortSignal that fires after `ms` plus a clear() for the timer. */
export function withDeadline(ms: number): { signal: AbortSignal; clear(): void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("deadline exceeded")), ms);
  // Node keeps the process alive for pending timers — don't let the deadline hold shutdown.
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

/** True when an abort came from the deadline (vs the client disconnecting). */
export function isDeadlineError(err: unknown): boolean {
  return err instanceof Error && err.message === "deadline exceeded";
}
