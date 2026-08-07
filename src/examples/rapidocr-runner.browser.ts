import type { OcrRunner } from "../ocr/rapidocr.js";

/**
 * Reference {@link OcrRunner} that adapts a community browser OCR package (built on
 * `onnxruntime-web` + RapidOCR/PaddleOCR models) to liteparse's runner contract.
 *
 * The package-side method names vary — this example follows the shape of
 * `client-side-ocr`; for `@paddleocr/paddleocr-js` swap the `recognize` call. The
 * PNG bytes from liteparse's rasteriser are decoded to an `ImageBitmap` the package
 * can consume.
 *
 *   npm install client-side-ocr onnxruntime-web
 *
 *   import { createOCR } from "client-side-ocr";
 *   import { createRapidOcrEngine, setBrowserOcrEngine } from "liteparse";
 *   import { createRunnerFromOcrPackage } from "./rapidocr-runner.browser"; // copy locally
 *
 *   const ocr = await createOCR(); // downloads models on first use
 *   setBrowserOcrEngine(createRapidOcrEngine({ runner: await createRunnerFromOcrPackage(ocr) }));
 */
export interface BrowserOcrPackageLike {
  recognize: (
    input: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  ) => Promise<{ text: string }>;
}

export async function createRunnerFromOcrPackage(
  ocr: BrowserOcrPackageLike,
): Promise<OcrRunner> {
  return {
    async recognize(image, ctx) {
      const blob = new Blob([image as unknown as BlobPart], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      if (ctx.signal?.aborted) throw new Error("aborted");
      const out = await ocr.recognize(bitmap);
      return { text: out.text ?? "" };
    },
  };
}
