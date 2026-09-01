/**
 * Browser Moonshine engine (onnxruntime-web/wasm) — `@drmoyassine/liteparse/engines/moonshine`.
 *
 * Consumer wiring (the whole browser STT tier):
 *
 * ```ts
 * import { createMoonshineSttEngine } from "@drmoyassine/liteparse/engines/moonshine";
 * import { createMoonshineModelOrigin } from "@drmoyassine/liteparse/engines/moonshine";
 * import { setBrowserSttEngine } from "@drmoyassine/liteparse";
 *
 * setBrowserSttEngine(
 *   createMoonshineSttEngine({
 *     languages: ["en", "ar"],
 *     modelOrigin: createMoonshineModelOrigin(),
 *   }),
 * );
 * ```
 *
 * Model weights fetch from HuggingFace and cache in IndexedDB; the tokenizer /
 * streaming-config JSONs are served same-origin from `/models/moonshine/`
 * (committed in this repo under apps/runner/models/moonshine — copy them to
 * your public dir; see model-origin-hf.ts for why they are not HF-fetched).
 * ort wasm glue comes from the same `/ort/` the RapidOCR engine uses
 * (scripts/copy-ort-wasm.mjs).
 */
export {
  createMoonshineRunner,
  createMoonshineSttEngine,
  MoonshineRunner,
} from "./moonshine-browser.js";
export type {
  MoonshineBrowserOptions,
  MoonshineRunnerHandle,
  MoonshineSttEngineOptions,
} from "./moonshine-browser.js";
export {
  createMoonshineModelOrigin,
  toMoonshineUrl,
  moonshineDescriptor,
  MOONSHINE_ARTIFACT_VERSION,
  MOONSHINE_SIDECAR_VERSION,
} from "./model-origin-hf.js";
