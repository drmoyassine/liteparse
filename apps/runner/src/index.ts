import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRapidOcrServerEngine } from "@drmoyassine/liteparse/ocr/rapidocr-server";
import { createLiteparseService } from "./service.js";
import { createSttService } from "./stt-service.js";

/**
 * Boot: config → app → listen, with the OCR + STT singletons warmed in the
 * background (first request shouldn't pay the model load; /health flips to
 * ocr:"ready" / stt:"ready" as each warms). SIGTERM/SIGINT close the listener
 * so in-flight requests drain.
 */

// Keep in sync with apps/runner/package.json (not imported — bundling JSON into
// the service bundle isn't worth it for a version string).
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const config = loadConfig();
  let ocrReady = false;
  let sttReady = false;

  const service = createLiteparseService();
  const sttService = createSttService({ modelPath: config.moonshineModelPath });
  const app = createApp({
    apiKey: config.apiKey,
    version: VERSION,
    service,
    sttService,
    maxBytes: config.maxBytes,
    maxTotalMs: config.maxTotalMs,
    sttMaxBytes: config.sttMaxBytes,
    sttMaxTotalMs: config.sttMaxTotalMs,
    maxConcurrency: config.maxConcurrency,
    ocrReady: () => ocrReady,
    sttReady: () => sttReady,
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

  // Same staging for STT: warm slot-1 EN only — the AR model (~28 MB) loads
  // lazily on the first ar request. Without local models /transcribe still
  // serves gateway-configured requests; /health reports stt:"unavailable".
  sttService
    .warm()
    .then(() => {
      sttReady = true;
      console.log("[runner] STT engine warmed — /health now reports stt:ready");
    })
    .catch((err: unknown) => {
      console.warn(
        "[runner] STT warm-up FAILED (serving gateway-only transcriptions; /health reports stt:unavailable):",
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
