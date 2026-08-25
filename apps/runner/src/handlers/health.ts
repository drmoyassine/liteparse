import type { Context } from "hono";

/** GET /health — the ONLY unauthenticated route (uptime probes + cutover verification). */
export function createHealthHandler(deps: {
  version: string;
  startedAt: number;
  ocrReady: () => boolean;
}) {
  return (c: Context) =>
    c.json({
      ok: true,
      version: deps.version,
      uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
      ocr: deps.ocrReady() ? "ready" : "unavailable",
    });
}
