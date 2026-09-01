/**
 * Ambient shims for optional native dependencies used only by opt-in subpath
 * adapters (`@drmoyassine/liteparse/raster/sharp`, `@drmoyassine/liteparse/ocr/rapidocr`). Declaring them as
 * `any` lets the package build and type-check without the packages installed; the
 * adapter factories still return fully-typed {@link import("./types.js").RasterAdapter}
 * / OcrEngine interfaces, so consumers' public API types are unaffected.
 */

declare module "sharp" {
  const sharp: any;
  export default sharp;
}

declare module "@napi-rs/canvas" {
  export const createCanvas: any;
}

declare module "onnxruntime-web" {
  const ort: any;
  export default ort;
  export const InferenceSession: any;
  export const Tensor: any;
  export const env: any;
}
