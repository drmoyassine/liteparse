import type { PdfDocumentLike, PreprocessOptions, RasterAdapter } from "../types.js";

/**
 * Browser raster adapter — renders a PDF page to a PNG using the Canvas API
 * (`OffscreenCanvas`, or a detached `<canvas>` as fallback). Pure DOM APIs, no
 * dependencies, so it is safe to include in the core bundle; it only runs in a
 * browser because {@link runtime.resolveRaster} loads it solely when a `window`
 * is present.
 *
 * Preprocessing (grayscale + contrast-normalisation) is done in a single
 * `ImageData` pass and exposed as pure pixel functions for unit testing.
 */

/* ---------------------------- pure pixel ops ---------------------------- */

/** Convert RGBA pixels to grayscale (luminosity weights) in place. */
export function grayscalePixels(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) | 0;
    data[i] = data[i + 1] = data[i + 2] = g;
  }
}

/**
 * Contrast-stretch RGBA pixels in place. The min/max are computed from luminance
 * (so colour images keep their hues) and each RGB channel is rescaled to span
 * the full 0–255 range — useful for dim scans before OCR.
 */
export function normalizePixels(data: Uint8ClampedArray): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) | 0;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  if (max - min === 0) return; // flat image (e.g. blank page) — nothing to stretch
  const range = max - min;
  const scale = 255 / range;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round((data[i]! - min) * scale);
    data[i + 1] = Math.round((data[i + 1]! - min) * scale);
    data[i + 2] = Math.round((data[i + 2]! - min) * scale);
  }
}

/* ------------------------------ canvas glue ------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCanvas = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;

function hasCanvas(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  return (
    typeof g.OffscreenCanvas !== "undefined" ||
    (typeof g.document !== "undefined" && typeof g.document.createElement === "function")
  );
}

function makeCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: AnyCtx } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas !== "undefined") {
    const canvas = new g.OffscreenCanvas(width, height);
    return { canvas, ctx: canvas.getContext("2d") };
  }
  if (typeof g.document !== "undefined") {
    const canvas = g.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext("2d") };
  }
  throw new Error("no canvas available in this runtime");
}

async function canvasToPng(canvas: AnyCanvas): Promise<Uint8Array> {
  if (typeof canvas.convertToBlob === "function") {
    const blob: Blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b: Blob | null) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

export const canvasRaster: RasterAdapter = {
  name: "canvas",
  runtime: "browser",

  /** Reflects whether a Canvas implementation exists in the current runtime. */
  get available(): boolean {
    return hasCanvas();
  },

  async rasterizePdfPage(
    doc: PdfDocumentLike,
    pageIndex: number,
    opts?: PreprocessOptions,
  ): Promise<Uint8Array> {
    const page = await doc.getPage(pageIndex + 1); // pdfjs pages are 1-based
    const base = page.getViewport({ scale: 1 });
    const maxEdge = opts?.maxEdge ?? 1600;
    // Render at the largest scale that keeps the longest edge ≤ maxEdge (never upscale).
    const scale = Math.min(1, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));

    const { canvas, ctx } = makeCanvas(width, height);
    // PDFs may have transparency — paint an opaque white background first.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    if (opts?.grayscale !== false) {
      const img = ctx.getImageData(0, 0, width, height);
      grayscalePixels(img.data);
      ctx.putImageData(img, 0, 0);
    }
    if (opts?.normalize) {
      const img = ctx.getImageData(0, 0, width, height);
      normalizePixels(img.data);
      ctx.putImageData(img, 0, 0);
    }

    return canvasToPng(canvas);
  },
};
