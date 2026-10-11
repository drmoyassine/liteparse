import type { Context } from "hono";
import type { ParseService } from "../service.js";
import type { Page, ParsedDocument } from "@drmoyassine/liteparse";
import type { ErrorJson, PageJson, ParseRequestBody, ParseResponseJson } from "../types.js";
import { isDeadlineError } from "../limits.js";
import { withDeadline, type Semaphore } from "../limits.js";
import { logRequest, newRequestId, redactVlm } from "../log.js";

/**
 * POST /parse — the whole HTTP contract lives here: request validation, size
 * limits, concurrency gate, deadline, and the EXACT response shape of studygram's
 * parse-document edge function (forwarders pass the body through unchanged).
 */
export function toPageJson(p: Page): PageJson {
  const out: PageJson = { page: p.pageNumber ?? p.index + 1, text: p.text, method: p.method ?? p.source };
  if (p.engine) out.engine = p.engine;
  if (p.reason) out.reason = p.reason;
  if (p.script) out.script = p.script;
  if (p.flags?.length) out.flags = p.flags;
  return out;
}

function toResponseJson(result: ParsedDocument, t0: number): ParseResponseJson {
  const json: ParseResponseJson = {
    text: result.text,
    kind: result.kind,
    source: result.source,
    page_count: result.pages.length,
    warnings: result.warnings,
    duration_ms: Date.now() - t0,
    pages: result.pages.map(toPageJson),
  };
  if (result.meta.encoding) json.encoding = result.meta.encoding;
  if (result.meta.format) json.format = result.meta.format;
  return json;
}

/** Accept: application/x-ndjson → stream, application/json → json, otherwise the default. */
export function pickResponseMode(accept: string | undefined, dflt: "stream" | "json"): "stream" | "json" {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("application/x-ndjson")) return "stream";
  if (a.includes("application/json")) return "json";
  return dflt;
}

function redactError(msg: string): string {
  return `parse failed: ${msg}`.replace(/Bearer\s+[\w.-]+/g, "Bearer ***");
}

export function createParseHandler(deps: {
  service: ParseService;
  maxBytes: number;
  maxTotalMs: number;
  /** Stream mode: budget per page (reset on every delivered page). */
  maxPageMs?: number;
  responseMode?: "stream" | "json";
  pageOutput?: "per-page" | "single";
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

    const options = { ...body.options };
    options.pageOutput ??= deps.pageOutput ?? "per-page";
    const mode = pickResponseMode(c.req.header("accept"), deps.responseMode ?? "json");

    if (mode === "stream") {
      // ── NDJSON: one page per line, then the result. Budget is per page. ──
      const pageMs = deps.maxPageMs ?? 120_000;
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error("deadline exceeded")), pageMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      };
      logRequest(id, `parse start (stream): ${bytes.length}B filename=${body.filename ?? "?"} options=${JSON.stringify(redactVlm(options))}`);
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
          arm();
          try {
            const result = await deps.service(bytes, body.filename, options, ctrl.signal, {
              onPage: (p) => {
                arm();
                send({ type: "page", ...toPageJson(p) });
              },
            });
            const json = toResponseJson(result, t0);
            logRequest(id, `parse ok (stream): ${result.text.length} chars source=${result.source} ${json.duration_ms}ms`);
            send({ type: "result", ...json });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logRequest(id, `parse FAILED (stream) after ${Date.now() - t0}ms${isDeadlineError(err) ? " (page deadline)" : ""}: ${msg}`);
            send({ type: "error", error: redactError(msg) });
          } finally {
            if (timer) clearTimeout(timer);
            release();
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }

    // ── json: parse under a hard deadline ────────────────────────────────────
    const deadline = withDeadline(deps.maxTotalMs);
    logRequest(
      id,
      `parse start: ${bytes.length}B filename=${body.filename ?? "?"} ` +
        `options=${JSON.stringify(redactVlm(options))}`,
    );
    try {
      const result = await deps.service(bytes, body.filename, options, deadline.signal);
      const json = toResponseJson(result, t0);
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
      return c.json({ error: redactError(msg) } satisfies ErrorJson, 500);
    } finally {
      deadline.clear();
      release();
    }
  };
}
