import type { VlmGateway, VlmReadOptions } from "../types.js";

/**
 * Reference browser VlmGateway: POSTs the image bytes to a consumer-owned endpoint
 * that runs the vision model server-side (so the model API key never reaches the
 * browser) and returns plain text.
 *
 * Usage:
 *   const vlm = createBrowserVlmGateway({
 *     url: "/api/parse-document/vlm",
 *     authorization: `Bearer ${sessionJwt}`,
 *   });
 *   const { text } = await parseDocument(file, { vlm });
 */
export interface BrowserVlmOptions {
  /** Endpoint that accepts an image body and returns the transcribed plain text. */
  url: string;
  /** Optional `Authorization` header value, e.g. `Bearer <jwt>`. */
  authorization?: string;
  /** Header name to carry the document hint (e.g. "X-Document-Hint"). */
  hintHeader?: string;
}

export function createBrowserVlmGateway(opts: BrowserVlmOptions): VlmGateway {
  return {
    async readImage(png: Uint8Array, ctx: VlmReadOptions = {}): Promise<string> {
      const headers: Record<string, string> = {
        "Content-Type": ctx.mime ?? "image/png",
      };
      if (opts.authorization) headers["Authorization"] = opts.authorization;
      if (ctx.hint && opts.hintHeader) headers[opts.hintHeader] = ctx.hint;

      const res = await fetch(opts.url, {
        method: "POST",
        headers,
        // Cast: TS 5.7+'s generic Uint8Array<ArrayBufferLike> isn't recognised as
        // BodyInit, though fetch accepts raw typed arrays at runtime in browsers.
        body: png as unknown as BodyInit,
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`vlm gateway HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.text()).trim();
    },
  };
}
