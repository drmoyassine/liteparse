import { defineConfig } from "tsup";

/**
 * liteparse build.
 *
 * The heavy / platform-specific deps are OPTIONAL peer dependencies that the
 * pipeline reaches only through dynamic `import()`. Listing them as `external`
 * guarantees the published bundle never inlines sharp / onnxruntime-web /
 * pdfjs-dist — so the browser bundle stays small and a runtime that lacks them
 * never tries to load them.
 *
 * The opt-in native adapters (sharp, RapidOCR) are also exposed as separate
 * subpath entry points (see package.json `exports`) so consumers pull them in
 * explicitly; the core bundle never contains them.
 */
export default defineConfig({
  // `index` is the isomorphic core; `raster/sharp` is an opt-in Node subpath that
  // pulls native deps (sharp + @napi-rs/canvas) and is never imported by the core.
  // `engines/rapidocr` is the opt-in browser RapidOCR engine (onnxruntime-web + PP-OCRv4).
  entry: {
    index: "src/index.ts",
    "raster/sharp": "src/raster/sharp.ts",
    "ocr/rapidocr-server": "src/ocr/rapidocr-server.ts",
    "vlm/server": "src/examples/vlm-gateway.server.ts",
    "engines/rapidocr": "src/engines/rapidocr/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["pdfjs-dist", "sharp", "@napi-rs/canvas", "onnxruntime-web", "onnxruntime-node"],
  // Keep the ESM dynamic-import graph intact (adapters load on demand).
  splitting: false,
});
