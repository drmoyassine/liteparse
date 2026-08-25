import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRapidOcrServerEngine } from "liteparse/ocr/rapidocr-server";
import { createLiteparseService } from "./service.js";

/**
 * Boot: config → app → listen, with the OCR singleton warmed in the background
 * (first request shouldn't pay the model load; /health flips to ocr:"ready"
 * when warm). SIGTERM/SIGINT close the listener so in-flight requests drain.
 */

// Keep in sync with apps/runner/package.json (not imported — bundling JSON into
// the service bundle isn't worth it for a version string).
const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  let ocrReady = false;

  const service = createLiteparseService();
  const app = createApp({
    apiKey: config.apiKey,
    version: VERSION,
    service,
    maxBytes: config.maxBytes,
    maxTotalMs: config.maxTotalMs,
    maxConcurrency: config.maxConcurrency,
    ocrReady: () => ocrReady,
    startedAt: Date.now(),
  });

  // Warm-up shares the process-wide engine singleton with the service. Failure is
  // NOT fatal: the runner still serves VLM-only parses and /health honestly
  // reports ocr:"unavailable" (the documented fallback staging).
  createRapidOcrServerEngine()
    .then(() => {
      ocrReady = true;
      console.log("[runner] OCR engine warmed — /health now reports ocr:ready");
    })
    .catch((err: unknown) => {
      console.warn(
        "[runner] OCR warm-up FAILED (serving VLM-only parses; /health reports ocr:unavailable):",
        err instanceof Error ? err.message : err,
      );
    });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[runner] parse-runner v${VERSION} listening on :${info.port}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[runner] ${sig} received — draining`);
    server.close(() => process.exit(0));
    // Drain deadline: don't hang shutdown on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[runner] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
