import type { Context } from "hono";
import type { OcrPageService } from "../service.js";
import type { ErrorJson, OcrRequestBody } from "../types.js";
import { withDeadline, type Semaphore } from "../limits.js";
import { logRequest, newRequestId } from "../log.js";

/**
 * POST /ocr — one page image through the runner's RapidOCR (English or Arabic
 * model by `script`). The browser → runner fallback: the AMS forwards a page here
 * (adding the runner key) when the browser has no model for the page's script or
 * is over its local page cap.
 */
export function createOcrHandler(deps: {
  service: OcrPageService | undefined;
  maxBytes: number;
  maxTotalMs: number;
  limiter: Semaphore;
}) {
  return async (c: Context): Promise<Response> => {
    if (!deps.service) return c.json({ error: "ocr not configured" } satisfies ErrorJson, 503);
    let body: OcrRequestBody;
    try {
      body = (await c.req.json()) as OcrRequestBody;
    } catch {
      return c.json({ error: "body must be JSON: {data: base64 image, script?}" } satisfies ErrorJson, 400);
    }
    if (typeof body?.data !== "string" || !/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(body.data.trim())) {
      return c.json({ error: "data (base64 image bytes) is required" } satisfies ErrorJson, 400);
    }
    const bytes = new Uint8Array(Buffer.from(body.data, "base64"));
    if (bytes.length === 0 || bytes.length > deps.maxBytes) {
      return c.json({ error: `image must be 1..${deps.maxBytes} bytes` } satisfies ErrorJson, 413);
    }
    const release = deps.limiter.tryAcquire();
    if (!release) {
      c.header("Retry-After", "2");
      return c.json({ error: "runner busy — retry shortly" } satisfies ErrorJson, 503);
    }
    const id = newRequestId();
    const deadline = withDeadline(deps.maxTotalMs);
    const t0 = Date.now();
    try {
      const pageIndex = Math.max(0, (body.pageNumber ?? 1) - 1);
      const out = await deps.service(bytes, {
        script: body.script,
        pageIndex,
        totalPages: body.totalPages ?? pageIndex + 1,
        signal: deadline.signal,
      });
      logRequest(id, `ocr ok: page ${pageIndex + 1} script=${out.script ?? "?"} ${out.text.length} chars ${Date.now() - t0}ms req=${body.requestId ?? "-"}`);
      return c.json({
        text: out.text,
        confidence: out.confidence ?? null,
        script: out.script ?? null,
        total_boxes: out.totalBoxes ?? null,
        dropped_boxes: out.droppedBoxes ?? null,
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRequest(id, `ocr FAILED: ${msg}`);
      return c.json({ error: `ocr failed: ${msg}` } satisfies ErrorJson, 500);
    } finally {
      deadline.clear();
      release();
    }
  };
}
