import { Hono } from "hono";
import { createApiKeyAuth } from "./auth.js";
import { createHealthHandler } from "./handlers/health.js";
import { createParseHandler } from "./handlers/parse.js";
import type { Semaphore } from "./limits.js";
import { createSemaphore } from "./limits.js";
import type { ParseService } from "./service.js";

/**
 * Side-effect-free app assembly — everything heavy (env, native adapters, the
 * HTTP listener) is injected, so tests drive the full HTTP surface through
 * app.request() without models or ports.
 */
export interface AppDeps {
  apiKey: string;
  version: string;
  service: ParseService;
  maxBytes?: number;
  maxTotalMs?: number;
  maxConcurrency?: number;
  /** Health reports "ready" only after the OCR singleton warmed. */
  ocrReady: () => boolean;
  startedAt?: number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const checkKey = createApiKeyAuth(deps.apiKey);
  const limiter = createSemaphore(deps.maxConcurrency ?? 2);

  // /health: unauthenticated by design (uptime probe + cutover verification).
  app.get("/health", createHealthHandler({
    version: deps.version,
    startedAt: deps.startedAt ?? Date.now(),
    ocrReady: deps.ocrReady,
  }));

  // Everything else requires the shared key. NO CORS anywhere — server-to-server
  // only; a browser must never hold this key.
  app.use("/parse", async (c, next) => {
    if (!checkKey(c.req.header("x-api-key"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.get("/parse", (c) => c.json({ error: "method not allowed — POST /parse" }, 405));
  app.post("/parse", createParseHandler({
    service: deps.service,
    maxBytes: deps.maxBytes ?? 20 * 1024 * 1024,
    maxTotalMs: deps.maxTotalMs ?? 110_000,
    limiter,
  }));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
