/**
 * Shared abort-error helpers.
 *
 * The router aborts at several layers (the pipeline pre-check, `executeRoute`
 * loop boundaries, the worker shell, the granite engine). Callers check aborts
 * idiomatically with `err.name === "AbortError"`, so every abort site must
 * produce a value whose `name` is `"AbortError"` — a plain `new Error("aborted")`
 * (name `"Error"`) is NOT recognisable as an abort and breaks that contract.
 * These helpers keep aborts consistent across every layer. See ROADMAP P4 (R2/R5).
 */

/**
 * Build a standard AbortError: a `DOMException` (name `"AbortError"`) when the
 * platform provides it, otherwise a plain `Error` whose `name` is set to
 * `"AbortError"`.
 */
export function abortError(message = "aborted"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/**
 * True if `err` represents an abort. Recognises a `DOMException` AbortError, a
 * plain `Error` named `"AbortError"`, and (defensively) the legacy
 * `Error("aborted")` message so callers still work during the transition.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (err instanceof Error) {
    return err.name === "AbortError" || err.message === "aborted";
  }
  return false;
}
