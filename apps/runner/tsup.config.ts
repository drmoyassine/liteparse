import { defineConfig } from "tsup";

// The runner is a deployed service, not a published library: bundle OUR code,
// externalize every dependency (natives must never be bundled; hono/node-server
// and liteparse resolve from node_modules in the runtime image).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  external: [
    "liteparse",
    "hono",
    "@hono/node-server",
    "sharp",
    "@napi-rs/canvas",
    "canvas",
    "onnxruntime-node",
    "pdfjs-dist",
    "dommatrix",
  ],
});
