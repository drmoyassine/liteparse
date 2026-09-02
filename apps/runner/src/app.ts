import { Hono } from "hono";
import type { Context, Next } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { createApiKeyAuth } from "./auth.js";
import { createHealthHandler } from "./handlers/health.js";
import { createParseHandler } from "./handlers/parse.js";
import { createTranscribeHandler } from "./handlers/transcribe.js";
import type { Semaphore } from "./limits.js";
import { createSemaphore } from "./limits.js";
import { createOpenApiDocument } from "./openapi.js";
import type { ParseService } from "./service.js";
import type { SttService } from "./stt-service.js";

/**
 * Side-effect-free app assembly — everything heavy (env, native adapters, the
 * HTTP listener) is injected, so tests drive the full HTTP surface through
 * app.request() without models or ports.
 */
export interface AppDeps {
  apiKey: string;
  version: string;
  service: ParseService;
  /** /transcribe service (the STT escalation walk). */
  sttService: SttService;
  maxBytes?: number;
  maxTotalMs?: number;
  /** Max decoded audio size for /transcribe (default 25 MB). */
  sttMaxBytes?: number;
  /** Hard wall-clock budget per /transcribe request (default 60 s). */
  sttMaxTotalMs?: number;
  maxConcurrency?: number;
  /** Health reports "ready" only after the OCR singleton warmed. */
  ocrReady: () => boolean;
  /** Health reports "ready" only after the slot-1 STT model warmed. */
  sttReady: () => boolean;
  startedAt?: number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const checkKey = createApiKeyAuth(deps.apiKey);
  // ONE semaphore for both endpoints — one box, one CPU/memory budget. A heavy
  // STT decode can 503 parses and vice versa; RUNNER_MAX_CONCURRENCY (default 2)
  // is the single knob that sizes the box. Deliberate, per ROADMAP Track 3.
  const limiter = createSemaphore(deps.maxConcurrency ?? 2);

  // /health: unauthenticated by design (uptime probe + cutover verification).
  app.get("/health", createHealthHandler({
    version: deps.version,
    startedAt: deps.startedAt ?? Date.now(),
    ocrReady: deps.ocrReady,
    sttReady: deps.sttReady,
  }));

  // /docs + /openapi.json: unauthenticated too — the API shape is public in the
  // repo README, and Swagger UI's try-it-out needs the key typed by the human
  // looking at the page (never baked into the spec). UI assets ship IN the image
  // (@hono/swagger-ui), so docs render on a network-isolated box.
  app.get("/openapi.json", (c) => c.json(createOpenApiDocument(deps.version)));
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Everything else requires the shared key. NO CORS anywhere — server-to-server
  // only; a browser must never hold this key.
  const requireKey = async (c: Context, next: Next) => {
    if (!checkKey(c.req.header("x-api-key"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
  app.use("/parse", requireKey);
  app.get("/parse", (c) => c.json({ error: "method not allowed — POST /parse" }, 405));
  app.post("/parse", createParseHandler({
    service: deps.service,
    maxBytes: deps.maxBytes ?? 20 * 1024 * 1024,
    maxTotalMs: deps.maxTotalMs ?? 110_000,
    limiter,
  }));

  app.use("/transcribe", requireKey);
  app.get("/transcribe", (c) => c.json({ error: "method not allowed — POST /transcribe" }, 405));
  app.post("/transcribe", createTranscribeHandler({
    service: deps.sttService,
    maxBytes: deps.sttMaxBytes ?? 25 * 1024 * 1024,
    maxTotalMs: deps.sttMaxTotalMs ?? 60_000,
    limiter,
  }));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
