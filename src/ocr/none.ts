import type { OcrContext, OcrEngine, OcrResult } from "../types.js";

/**
 * Null OCR engine — the default when no recogniser is available. `available: false`
 * tells the pipeline to fall straight through to the VLM gateway (if any).
 */
export const noneOcr: OcrEngine = {
  name: "none",
  available: false,
  async recognize(_image: Uint8Array, _ctx: OcrContext): Promise<OcrResult> {
    return { text: "", confidence: 0 };
  },
};
