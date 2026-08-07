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
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["pdfjs-dist", "sharp", "@napi-rs/canvas", "onnxruntime-web"],
  // Keep the ESM dynamic-import graph intact (adapters load on demand).
  splitting: false,
});
