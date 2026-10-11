import type { OcrContext, OcrEngine, OcrResult, VlmGateway, VlmReadOptions } from "../types.js";

/**
 * HTTP clients for steps that run outside the current runtime:
 *  - {@link createRunnerOcrEngine}: browser → runner RapidOCR (English + Arabic models)
 *    for pages the router marks "edge". The runner key never reaches the browser: the
 *    AMS supplies either a function or a proxy URL that adds the key and forwards to
 *    the runner's `POST /ocr`.
 *  - {@link createVisionEndpointGateway}: a {@link VlmGateway} that POSTs each page
 *    image (with page/script/reason context) to an AMS vision endpoint, so every
 *    vision call goes through the AMS's own settings, logging and data rules.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Body of the runner's `POST /ocr` (one page image). */
export interface RunnerOcrRequest {
  data: string;
  script?: string;
  pageNumber?: number;
  totalPages?: number;
  documentName?: string;
  requestId?: string;
}

/** Response of the runner's `POST /ocr`. */
export interface RunnerOcrResponse {
  text: string;
  confidence?: number | null;
  script?: string;
  total_boxes?: number;
  dropped_boxes?: number;
}

export interface RunnerOcrClientOptions {
  /** AMS proxy URL forwarding to the runner's `POST /ocr` (adds the runner key server-side). */
  url?: string;
  /** Extra headers for `url` (e.g. the AMS session token — never the runner key). */
  headers?: Record<string, string>;
  /** Alternatively: do the call yourself (e.g. through an existing AMS RPC). */
  call?: (req: RunnerOcrRequest, signal?: AbortSignal) => Promise<RunnerOcrResponse>;
  fetch?: typeof fetch;
}

/** OCR engine backed by the runner's RapidOCR (Latin + Arabic). */
export function createRunnerOcrEngine(opts: RunnerOcrClientOptions): OcrEngine {
  if (!opts.url && !opts.call) throw new Error("createRunnerOcrEngine: url or call is required");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const call =
    opts.call ??
    (async (req: RunnerOcrRequest, signal?: AbortSignal): Promise<RunnerOcrResponse> => {
      const res = await doFetch(opts.url!, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(req),
        signal,
      });
      if (!res.ok) throw new Error(`runner ocr HTTP ${res.status}`);
      return (await res.json()) as RunnerOcrResponse;
    });
  return {
    name: "runner",
    available: true,
    scripts: ["latin", "arabic"],
    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      const out = await call(
        {
          data: bytesToBase64(image),
          script: ctx.script,
          pageNumber: ctx.pageIndex + 1,
          totalPages: ctx.totalPages,
          documentName: ctx.documentName,
          requestId: ctx.requestId,
        },
        ctx.signal,
      );
      return {
        text: (out.text ?? "").trim(),
        confidence: out.confidence ?? undefined,
        script: out.script,
        totalBoxes: out.total_boxes,
        droppedBoxes: out.dropped_boxes,
      };
    },
  };
}

export interface VisionEndpointOptions {
  /** AMS vision endpoint: receives `{image, mime, pageNumber, …context}`, returns `{text}`. */
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** {@link VlmGateway} that defers every page image to the AMS vision endpoint. */
export function createVisionEndpointGateway(opts: VisionEndpointOptions): VlmGateway {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async readImage(png: Uint8Array, o: VlmReadOptions = {}): Promise<string> {
      const { signal, ...context } = o;
      try {
        const res = await doFetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...opts.headers },
          body: JSON.stringify({ image: bytesToBase64(png), ...context }),
          signal,
        });
        if (!res.ok) return "";
        const body = (await res.json()) as { text?: string };
        return body.text ?? "";
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        return "";
      }
    },
  };
}
