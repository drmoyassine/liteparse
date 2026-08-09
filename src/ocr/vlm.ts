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
        // Sniff the real MIME from magic bytes so a JPEG/WebP phone photo isn't
        // mislabelled image/png (which most providers reject/mis-decode). Falls
        // back to the caller's defaultMime for unknown magic. (P4 / R5.)
        mime: sniffImageMime(image, defaultMime),
      });
      return { text: (text ?? "").trim() };
    },
  };
}

/**
 * Sniff an image's MIME type from its magic bytes. Returns the `fallback` when the
 * bytes don't match a known image signature (so non-image page bytes, e.g. a stray
 * PNG-less buffer, still get a MIME to send the gateway).
 */
function sniffImageMime(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // RIFF….WEBP container.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return fallback;
}
