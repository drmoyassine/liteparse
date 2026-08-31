import type { Context } from "hono";

/** GET /health — the ONLY unauthenticated route (uptime probes + cutover verification). */
export function createHealthHandler(deps: {
  version: string;
  startedAt: number;
  ocrReady: () => boolean;
  /** True once the slot-1 STT model preloaded (background warm at boot). */
  sttReady: () => boolean;
}) {
  return (c: Context) =>
    c.json({
      ok: true,
      version: deps.version,
      uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
      ocr: deps.ocrReady() ? "ready" : "unavailable",
      stt: deps.sttReady() ? "ready" : "unavailable",
    });
}
