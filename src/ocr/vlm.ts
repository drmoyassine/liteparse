import type { OcrContext, OcrEngine, OcrResult, VlmGateway } from "../types.js";

/**
 * Wrap an injected {@link VlmGateway} as an {@link OcrEngine}. This is for callers
 * who want to route OCR through the unified engine abstraction (e.g. to pass as
 * `options.ocrEngine`). Note: the pipeline already calls the VLM gateway directly
 * as its OCR fallback, so most callers do not need this factory — use it only when
 * you specifically want VLM to be the *engine* (its output is tagged `source: "ocr"`).
 */
export function createVlmOcrEngine(
  vlm: VlmGateway,
  defaultMime = "image/png",
): OcrEngine {
  return {
    name: "vlm",
    available: true,
    async recognize(image: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      const text = await vlm.readImage(image, {
        pageIndex: ctx.pageIndex,
        totalPages: ctx.totalPages,
        hint: ctx.hint,
        signal: ctx.signal,
        mime: defaultMime,
      });
      return { text: (text ?? "").trim() };
    },
  };
}
