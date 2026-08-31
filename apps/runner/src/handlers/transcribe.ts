import type { Context } from "hono";
import { isDeadlineError } from "../limits.js";
import { withDeadline, type Semaphore } from "../limits.js";
import { logRequest, newRequestId, redactVlm } from "../log.js";
import { TranscribeHttpError, type SttService } from "../stt-service.js";
import type {
  ErrorJson,
  RequestedTranscribeOptions,
  TranscribeRequestBody,
  TranscribeResponseJson,
} from "../types.js";

/**
 * POST /transcribe — the parse validation ladder, cloned for audio: JSON body,
 * base64 discipline BEFORE decode (Node's Buffer silently drops bad chars),
 * size limit, the SHARED concurrency gate, a hard deadline, and the exact
 * response key set. Undecodable audio is a 422 (a client contract violation,
 * unlike a parse failure which is always 500).
 */
export function createTranscribeHandler(deps: {
  service: SttService;
  maxBytes: number;
  maxTotalMs: number;
  limiter: Semaphore;
}) {
  return async (c: Context): Promise<Response> => {
    const id = newRequestId();
    const t0 = Date.now();

    // ── body: JSON {data: base64, filename?, options?} ──────────────────────
    let body: TranscribeRequestBody;
    try {
      body = (await c.req.json()) as TranscribeRequestBody;
    } catch {
      return c.json({ error: "body must be JSON: {data: base64, filename, options?}" } satisfies ErrorJson, 400);
    }
    if (typeof body?.data !== "string" || body.data.trim() === "") {
      return c.json({ error: "data (base64 audio bytes) is required" } satisfies ErrorJson, 400);
    }
    if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(body.data.trim())) {
      return c.json({ error: "data is not valid base64" } satisfies ErrorJson, 400);
    }
    const bytes = new Uint8Array(Buffer.from(body.data, "base64"));
    if (bytes.length === 0) {
      return c.json({ error: "audio is empty" } satisfies ErrorJson, 400);
    }
    if (bytes.length > deps.maxBytes) {
      return c.json(
        { error: `audio exceeds size limit (${bytes.length} > ${deps.maxBytes} bytes)` } satisfies ErrorJson,
        413,
      );
    }
    const optError = validateOptions(body.options);
    if (optError) {
      return c.json({ error: optError } satisfies ErrorJson, 400);
    }

    // ── concurrency gate (shared with /parse — one box, one budget) ─────────
    const release = deps.limiter.tryAcquire();
    if (!release) {
      c.header("Retry-After", "2");
      return c.json({ error: "runner busy — retry shortly" } satisfies ErrorJson, 503);
    }

    // ── transcribe under a hard deadline ─────────────────────────────────────
    const deadline = withDeadline(deps.maxTotalMs);
    // redactVlm masks every `apiKey` key it finds — options.stt included.
    logRequest(
      id,
      `transcribe start: ${bytes.length}B filename=${body.filename ?? "?"} ` +
        `options=${JSON.stringify(redactVlm(body.options ?? {}))}`,
    );
    try {
      const result = await deps.service.transcribe(bytes, body.filename, body.options, deadline.signal);
      const json: TranscribeResponseJson = {
        text: result.text,
        language: result.language,
        engine: result.engine,
        confidence: result.confidence,
        warnings: result.warnings,
        duration_ms: Date.now() - t0,
      };
      logRequest(
        id,
        `transcribe ok: ${result.text.length} chars engine=${result.engine} lang=${result.language} ` +
          `conf=${result.confidence === null ? "n/a" : result.confidence.toFixed(2)} ` +
          `${json.duration_ms}ms (${result.warnings.length} warnings)`,
      );
      return c.json(json);
    } catch (err) {
      // Typed service failures carry their own status (422 undecodable audio,
      // 503 nothing runnable). Everything else — decode crash, deadline — is a
      // 500, same policy as /parse.
      const status = err instanceof TranscribeHttpError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      logRequest(
        id,
        `transcribe FAILED (${status}) after ${Date.now() - t0}ms${isDeadlineError(err) ? " (deadline)" : ""}: ${msg}`,
      );
      return c.json(
        { error: `transcribe failed: ${msg}`.replace(/Bearer\s+[\w.-]+/g, "Bearer ***") } satisfies ErrorJson,
        status as 422 | 503 | 500,
      );
    } finally {
      deadline.clear();
      release();
    }
  };
}

/** Structural validation of options — bad shape is a 400, not a downstream 500. */
function validateOptions(options: RequestedTranscribeOptions | undefined): string | null {
  if (options === undefined) return null;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return "options must be an object";
  }
  if (options.language !== undefined && options.language !== "en" && options.language !== "ar") {
    return 'options.language must be "en" or "ar"';
  }
  if (options.keepDiacritics !== undefined && typeof options.keepDiacritics !== "boolean") {
    return "options.keepDiacritics must be a boolean";
  }
  const stt = options.stt;
  if (stt !== undefined) {
    if (typeof stt !== "object" || stt === null || Array.isArray(stt)) {
      return "options.stt must be an object";
    }
    for (const key of ["endpoint", "apiKey", "model"] as const) {
      if (typeof stt[key] !== "string" || stt[key].trim() === "") {
        return `options.stt.${key} is required`;
      }
    }
  }
  return null;
}
