import type { ModelDescriptor, ModelOrigin } from "../../worker/model-origin.js";
import { MOONSHINE_MODELS, fileUrl, type MoonshineModelDescriptor } from "./shared/models.js";

/**
 * Public-source model origin for the browser Moonshine engine — the STT
 * counterpart of engines/rapidocr/model-origin-hf.ts.
 *
 * Binaries stream from HuggingFace `/resolve/` (permissive CORS, same as the
 * PP-OCR ONNX files) and cache in IndexedDB via liteparse's resolveModel.
 * The JSON sidecars (tokenizer.json, streaming_config.json) are served from
 * OUR OWN origin instead — the dict precedent, for a sharper reason here: a
 * silently-updated HF tokenizer garbage-decodes EVERY transcript while every
 * byte-identical-looking model stays cached ("valid"); hosting the sidecars
 * pins the decode table to bytes the app ships. They are committed in this
 * repo at apps/runner/models/moonshine/<dir>/*.json — copy them to
 * `<origin>/models/moonshine/<dir>/` (the runner fetch script documents the
 * same files). A consumer wanting full pinning injects their own ModelOrigin.
 *
 * AR tiny is license "other" (see shared/models.ts): browser download is use,
 * never npm-redistribution — same stance as PP-OCR today.
 */

/**
 * Cache version for the ONNX/ORT binaries. Bump → IndexedDB miss → re-fetch.
 * Independent of the descriptor set (ids map through shared/models.ts).
 */
export const MOONSHINE_ARTIFACT_VERSION = "1.0.0";
/**
 * Cache version for tokenizer.json / streaming_config.json — bumped
 * independently (the DICT_VERSION precedent) so a corrected sidecar re-fetches
 * without re-downloading ~112 MB of model weights.
 */
export const MOONSHINE_SIDECAR_VERSION = "1.0.0";

/** Descriptor for one FILE of a model (`id` = `<modelId>/<role>`). */
export function moonshineDescriptor(
  desc: MoonshineModelDescriptor,
  role: string,
): ModelDescriptor {
  const sidecar = role === "tokenizer" || role === "streamingConfig";
  return {
    id: `${desc.id}/${role}`,
    version: sidecar ? MOONSHINE_SIDECAR_VERSION : MOONSHINE_ARTIFACT_VERSION,
  };
}

/** Role names that must be served same-origin (everything else → HF /resolve/). */
function isSidecarRole(role: string): boolean {
  return role === "tokenizer" || role === "streamingConfig";
}

/**
 * Map descriptor.id ("<modelId>/<role>") → its source URL.
 *
 *   moonshine-streaming-tiny-en/frontend → HF …/onnx/tiny/frontend.ort
 *   moonshine-batch-tiny-ar/tokenizer    → <own origin>/models/moonshine/batch-tiny-ar/tokenizer.json
 */
export function toMoonshineUrl(descriptor: ModelDescriptor): string {
  const slash = descriptor.id.indexOf("/");
  const modelId = slash > 0 ? descriptor.id.slice(0, slash) : "";
  const role = slash > 0 ? descriptor.id.slice(slash + 1) : "";
  const desc = MOONSHINE_MODELS[modelId];
  const file = desc?.files[role];
  if (!desc || !file) {
    throw new Error(
      `unknown model id: ${descriptor.id} (expected "<modelId>/<role>" keyed by shared/models.ts — add to toMoonshineUrl mapping)`,
    );
  }
  if (isSidecarRole(role)) {
    return self.location.origin + "/models/moonshine/" + desc.dir + "/" + file.file;
  }
  return fileUrl(desc, role);
}

/**
 * Create the public Moonshine origin with timeout protection (the RapidOCR
 * origin's exact policy): a stalled HF/same-origin fetch fails LOUDLY after
 * 30 s instead of hanging the worker's parse budget with no diagnostics.
 */
export function createMoonshineModelOrigin(): ModelOrigin {
  return {
    async fetchModel(d: ModelDescriptor): Promise<Uint8Array> {
      const url = toMoonshineUrl(d);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`Model fetch ${d.id}@${d.version} → ${url} HTTP ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Model fetch ${d.id}@${d.version} → ${url} timed out after 30s (check network / that /models/moonshine sidecars are deployed)`);
        }
        throw err;
      }
    },
  };
}
