/**
 * Synchronous, headless-safe runtime capability detection for the
 * Intelligent Document Router.
 *
 * Produces the {@link RuntimeCapabilities} that gate routing (e.g. no WebGPU ⇒
 * Granite-Docling can't run in-browser ⇒ those docs route to edge Granite).
 *
 * Every probe is behind a `typeof` guard so the function never throws in any
 * runtime — node, deno, browser, or a stripped/jsdom test environment. Anything
 * that would require an `await` is intentionally deferred to the worker (P2):
 *   - a real WebGPU `navigator.gpu.requestAdapter()` probe,
 *   - `navigator.storage.persist()` (storagePersisted),
 *   - enriching `availableScripts` from the model cache.
 * Here we only read synchronously-available signals, then let the caller force
 * any field via {@link CapabilityOverrides}.
 *
 * See ARCHITECTURE.md → Capability Detection, ROADMAP.md → Phase 1.
 */
import type { RuntimeCapabilities, Script } from "./types.js";

/** Caller/test injection. When provided, every field overrides the detected value. */
export interface CapabilityOverrides {
  runtime?: "browser" | "node" | "deno";
  hasWebGPU?: boolean;
  metered?: boolean;
  availableScripts?: Script[];
  storagePersisted?: boolean;
}

/** Scripts always considered available. Latin is the always-loaded baseline. */
const BASELINE_SCRIPTS: readonly Script[] = ["latin"];

/** Network Information API `effectiveType` values treated as metered/slow. */
const METERED_EFFECTIVE_TYPES: readonly string[] = ["slow-2g", "2g"];

/**
 * Detect the JS runtime from synchronously-available globals.
 * - `Deno` present  → deno
 * - both `window` and `navigator` present → browser
 * - otherwise → node
 *
 * `Deno` is accessed through `globalThis` (not as a bare identifier): a bare
 * `typeof Deno` would not throw at runtime, but with `types: ["node"]` TS has no
 * `Deno` declaration and would flag it as "Cannot find name". The globalThis
 * access is equally headless-safe.
 */
function detectRuntime(): "browser" | "node" | "deno" {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (typeof g.Deno !== "undefined") return "deno";
  if (typeof g.window !== "undefined" && typeof g.navigator !== "undefined") {
    return "browser";
  }
  return "node";
}

/**
 * Synchronous WebGPU feature-presence check (browser only).
 *
 * A deeper asynchronous probe via `navigator.gpu.requestAdapter()` is a P2
 * refinement. Presence of a truthy `navigator.gpu` is a strong-enough signal
 * that an adapter is likely, and the router only needs to know whether to
 * *consider* in-browser Granite — the worker re-checks (and the model load can
 * still fail fast) before committing. With no adapter available at all,
 * `navigator.gpu` is undefined, so this returns false.
 */
function detectHasWebGPU(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { gpu?: unknown };
  return "gpu" in nav && Boolean(nav.gpu);
}

/**
 * Synchronous metered/slow-connection check from the Network Information API
 * (browser only). Honours `navigator.connection.saveData` and treats
 * `effectiveType` of `slow-2g`/`2g` as metered so large model downloads defer.
 */
function detectMetered(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const conn = nav.connection;
  if (!conn) return false;
  if (conn.saveData === true) return true;
  return (
    typeof conn.effectiveType === "string" &&
    METERED_EFFECTIVE_TYPES.includes(conn.effectiveType)
  );
}

/**
 * Best-effort, synchronous detection of what this runtime can do. Never throws.
 *
 * WebGPU and metering are browser concepts, so their detected defaults are
 * `false` in node/deno. `availableScripts` and `storagePersisted` have no sync
 * detection: latin is the always-loaded baseline (the worker enriches scripts
 * from the model cache in P2), and `storagePersisted` defaults `false` until
 * the worker calls `navigator.storage.persist()` asynchronously.
 *
 * Every field can be forced via {@link CapabilityOverrides}; overrides always
 * win over detected values. (`??` is used deliberately so an explicit `false`
 * override beats a detected `true`.)
 */
export function detectCapabilities(
  overrides?: CapabilityOverrides,
): RuntimeCapabilities {
  const runtime = overrides?.runtime ?? detectRuntime();

  // WebGPU and metering are only meaningful in a browser; default false elsewhere.
  const detectedHasWebGPU = runtime === "browser" ? detectHasWebGPU() : false;
  const detectedMetered = runtime === "browser" ? detectMetered() : false;

  return {
    runtime,
    hasWebGPU: overrides?.hasWebGPU ?? detectedHasWebGPU,
    metered: overrides?.metered ?? detectedMetered,
    availableScripts:
      overrides?.availableScripts ?? ([...BASELINE_SCRIPTS] as Script[]),
    storagePersisted: overrides?.storagePersisted ?? false,
  };
}
