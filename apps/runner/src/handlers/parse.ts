import type { Context } from "hono";
import type { ParseService } from "../service.js";
import type { ErrorJson, ParseRequestBody, ParseResponseJson } from "../types.js";
import { isDeadlineError } from "../limits.js";
import { withDeadline, type Semaphore } from "../limits.js";
import { logRequest, newRequestId, redactVlm } from "../log.js";

/**
 * POST /parse — the whole HTTP contract lives here: request validation, size
 * limits, concurrency gate, deadline, and the EXACT response shape of studygram's
 * parse-document edge function (forwarders pass the body through unchanged).
 */
export function createParseHandler(deps: {
  service: ParseService;
  maxBytes: number;
  maxTotalMs: number;
  limiter: Semaphore;
}) {
  return async (c: Context): Promise<Response> => {
    const id = newRequestId();
    const t0 = Date.now();

    // ── body: JSON {data: base64, filename?, options?} ──────────────────────
    let body: ParseRequestBody;
    try {
      body = (await c.req.json()) as ParseRequestBody;
    } catch {
      return c.json({ error: "body must be JSON: {data: base64, filename, options?}" } satisfies ErrorJson, 400);
    }
    if (typeof body?.data !== "string" || body.data.trim() === "") {
      return c.json({ error: "data (base64 document bytes) is required" } satisfies ErrorJson, 400);
    }

    // Node's Buffer silently drops invalid base64 chars (→ empty/garbage bytes), so
    // validate the alphabet BEFORE decoding rather than discovering it downstream.
    if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(body.data.trim())) {
      return c.json({ error: "data is not valid base64" } satisfies ErrorJson, 400);
    }
    const bytes = new Uint8Array(Buffer.from(body.data, "base64"));
    if (bytes.length === 0) {
      return c.json({ error: "document is empty" } satisfies ErrorJson, 400);
    }
    if (bytes.length > deps.maxBytes) {
      return c.json(
        { error: `document exceeds size limit (${bytes.length} > ${deps.maxBytes} bytes)` } satisfies ErrorJson,
        413,
      );
    }

    // ── concurrency gate ─────────────────────────────────────────────────────
    const release = deps.limiter.tryAcquire();
    if (!release) {
      c.header("Retry-After", "2");
      return c.json({ error: "runner busy — retry shortly" } satisfies ErrorJson, 503);
    }

    // ── parse under a hard deadline ──────────────────────────────────────────
    const deadline = withDeadline(deps.maxTotalMs);
    logRequest(
      id,
      `parse start: ${bytes.length}B filename=${body.filename ?? "?"} ` +
        `options=${JSON.stringify(redactVlm(body.options ?? {}))}`,
    );
    try {
      const result = await deps.service(bytes, body.filename, body.options, deadline.signal);
      const json: ParseResponseJson = {
        text: result.text,
        kind: result.kind,
        source: result.source,
        page_count: result.pages.length,
        warnings: result.warnings,
        duration_ms: Date.now() - t0,
      };
      logRequest(
        id,
        `parse ok: ${result.text.length} chars source=${result.source} ` +
          `${json.duration_ms}ms (${result.warnings.length} warnings)`,
      );
      return c.json(json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 500 for every parse failure (incl. deadline): the forwarders treat any
      // non-2xx as "fall back to in-process" — distinguishing 504 adds nothing.
      logRequest(
        id,
        `parse FAILED (500) after ${Date.now() - t0}ms${isDeadlineError(err) ? " (deadline)" : ""}: ${msg}`,
      );
      // The error text could embed a VLM config (gateway construction/validation);
      // redacted defensively — a raw key must never reach a response or log.
      return c.json({ error: `parse failed: ${msg}`.replace(/Bearer\s+[\w.-]+/g, "Bearer ***") } satisfies ErrorJson, 500);
    } finally {
      deadline.clear();
      release();
    }
  };
}
