import type { PdfDocumentLike, PreprocessOptions, RasterAdapter } from "../types.js";

/**
 * Node raster adapter (opt-in subpath `@drmoyassine/liteparse/raster/sharp`).
 *
 * Not imported by the core bundle. The consumer installs the native deps and
 * creates the adapter explicitly:
 *
 *   import { createSharpRaster } from "@drmoyassine/liteparse/raster/sharp";
 *   const raster = await createSharpRaster();
 *   const { text } = await parseDocument(file, { raster, vlm });
 *
 * Requires two optional native packages:
 *   - `@napi-rs/canvas` — provides the 2D canvas pdfjs renders into (no system deps)
 *   - `sharp` — high-quality grayscale/normalise/resize + fast PNG encode
 *
 * Both are loaded via dynamic `import()` inside the factory, so importing this
 * subpath never crashes a runtime that lacks them — the factory rejects instead.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sharp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeCanvas = any;

export async function createSharpRaster(): Promise<RasterAdapter> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ default: sharp }, canvasMod]: [{ default: Sharp }, any] = await Promise.all([
    import("sharp"),
    import("@napi-rs/canvas"),
  ]);
  const createCanvas: ((w: number, h: number) => NodeCanvas) | undefined =
    canvasMod.createCanvas ?? canvasMod.default?.createCanvas;
  if (typeof createCanvas !== "function") {
    throw new Error("@napi-rs/canvas did not expose createCanvas");
  }

  return {
    name: "sharp",
    runtime: "node",
    available: true,

    async rasterizePdfPage(
      doc: PdfDocumentLike,
      pageIndex: number,
      opts?: PreprocessOptions,
    ): Promise<Uint8Array> {
      const page = await doc.getPage(pageIndex + 1); // pdfjs pages are 1-based
      const base = page.getViewport({ scale: 1 });
      const maxEdge = opts?.maxEdge ?? 1600;
      const scale = Math.min(1, maxEdge / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));

      // Render the page into a Node canvas, then hand the PNG to sharp for
      // preprocessing + encode.
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png: Uint8Array = canvas.toBuffer("image/png");

      let pipeline = sharp(png);
      if (opts?.grayscale !== false) pipeline = pipeline.grayscale();
      if (opts?.normalize) pipeline = pipeline.normalise();
      pipeline = pipeline.resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
      const out: Uint8Array = await pipeline.png().toBuffer();
      return new Uint8Array(out);
    },
  };
}
