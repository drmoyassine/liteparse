import type { PdfDocumentLike, PreprocessOptions, RasterAdapter } from "../types.js";

/**
 * Null raster adapter — the default when no platform renderer is available (e.g.
 * Deno/edge). It is explicitly `available: false`; the pipeline checks that flag
 * before calling {@link rasterizePdfPage}, so this method only runs as a guard.
 */
export const noneRaster: RasterAdapter = {
  name: "none",
  runtime: "none",
  available: false,
  async rasterizePdfPage(_doc: PdfDocumentLike, _pageIndex: number, _opts?: PreprocessOptions): Promise<Uint8Array> {
    throw new Error("no raster adapter available for this runtime");
  },
};
