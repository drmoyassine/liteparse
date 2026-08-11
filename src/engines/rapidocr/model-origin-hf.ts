import type { ModelDescriptor, ModelOrigin } from "../../worker/model-origin.js";

/**
 * Public-source model origin for the OCR Web Worker (browser-only).
 *
 * Models are fetched from a public source and cached in IndexedDB via
 * liteparse's resolveModel/model-cache.ts. This is the browser counterpart to
 * the S3 origin used by the edge — see [[liteparse-infra-platform-scope]].
 *
 * For PP-OCRv4 Latin models, we fetch ONNX files from HuggingFace repos with
 * permissive CORS (HF serves access-control-allow-origin: * — works for browser fetch):
 * - Det: Heliosoph/paddleocr-v4-det-onnx → ch_PP-OCRv4_det.onnx (Chinese det, handles Latin)
 * - Rec: breezedeus/cnocr-ppocr-en_PP-OCRv4 → en_PP-OCRv4_rec_infer.onnx (English rec)
 * - Dict: the canonical PaddleOCR English charset (94 ASCII chars), served from our own
 *   origin at /models/ppocr-en-dict.txt — see the dict branch in toModelUrl.
 *
 * The descriptor.id is mapped to a public URL where the file lives.
 */

/**
 * Map model.id → its source URL. The id comes from the router's ModelDescriptor.
 *
 * PP-OCRv4 detection + English recognition ONNX files (HuggingFace /resolve/, permissive CORS):
 * - Detection: Heliosoph/paddleocr-v4-det-onnx → ch_PP-OCRv4_det.onnx
 * - Recognition: breezedeus/cnocr-ppocr-en_PP-OCRv4 → en_PP-OCRv4_rec_infer.onnx
 * - Character dict: canonical PaddleOCR English charset → /models/ppocr-en-dict.txt (own origin)
 */
function toModelUrl(descriptor: ModelDescriptor): string {
  // PP-OCRv4 detection
  if (descriptor.id.startsWith("pp-ocrv4-det-latin")) {
    return "https://huggingface.co/Heliosoph/paddleocr-v4-det-onnx/resolve/main/ch_PP-OCRv4_det.onnx";
  }
  // PP-OCRv4 English recognition
  if (descriptor.id.startsWith("pp-ocrv4-rec-latin")) {
    return "https://huggingface.co/breezedeus/cnocr-ppocr-en_PP-OCRv4/resolve/main/en_PP-OCRv4_rec_infer.onnx";
  }
  // Character dictionary — the canonical PaddleOCR English charset (94 printable ASCII
  // chars, byte-exact copy of ppocr/utils/en_dict.txt). Served from our OWN origin
  // (public/models/ppocr-en-dict.txt) so the rec model's CTC output classes always line
  // up with the dict. Do NOT use monkt/paddleocr-onnx's languages/english/dict.txt — that
  // is a 436-char MULTILINGUAL symbol set (Greek Α-ω, math ∀∫√≈, currency €£¥₹, Roman Ⅰ-ⅻ,
  // circled ①-➓, accented À-ÿ). Pairing it with the stock PP-OCRv4 English rec model is
  // the root cause of the v4 regression: the model faithfully emits indices into its own
  // 94-char charset, but those indices map into the middle of the wrong block → symbol
  // salad (`Nlr^ny^p"lqv"v\1&|A@P!`). Same-origin also sidesteps any CORS variance.
  if (descriptor.id.startsWith("pp-ocrv4-dict-latin")) {
    return self.location.origin + "/models/ppocr-en-dict.txt";
  }
  throw new Error(`unknown model id: ${descriptor.id} (add to toModelUrl mapping)`);
}

export function createPublicModelOrigin(): ModelOrigin {
  return {
    async fetchModel(d: ModelDescriptor): Promise<Uint8Array> {
      const url = toModelUrl(d);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Model fetch ${d.id}@${d.version} → ${url} HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
