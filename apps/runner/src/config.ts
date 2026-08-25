/**
 * Runner configuration, resolved once at boot from the environment.
 * Tests never touch this — createApp receives its deps explicitly.
 */
export interface RunnerConfig {
  port: number;
  /** Shared secret required on POST /parse (X-API-Key). Server refuses to start without it. */
  apiKey: string;
  /** Directory holding the PP-OCRv4 det/rec/dict artifacts (consumed by the OCR engine). */
  rapidocrModelPath: string | undefined;
  /** Max simultaneous /parse in flight; excess gets 503 + Retry-After. */
  maxConcurrency: number;
  /** Hard wall-clock budget per /parse request. */
  maxTotalMs: number;
  /** Max decoded document size. */
  maxBytes: number;
  /** Extra budget above maxTotalMs for the client round-trip (forwarders abort at 120s). */
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const apiKey = env.PARSE_RUNNER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "PARSE_RUNNER_API_KEY is required (generate one, e.g. `openssl rand -hex 32`). " +
        "The runner refuses to start without it — an open parse endpoint would spend VLM credits.",
    );
  }
  return {
    port: intEnv(env.PORT, 3000),
    apiKey,
    rapidocrModelPath: env.RAPIDOCR_MODEL_PATH?.trim() || undefined,
    maxConcurrency: intEnv(env.RUNNER_MAX_CONCURRENCY, 2),
    maxTotalMs: intEnv(env.RUNNER_MAX_TOTAL_MS, 110_000),
    maxBytes: intEnv(env.RUNNER_MAX_BYTES, 20 * 1024 * 1024),
  };
}

function intEnv(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
