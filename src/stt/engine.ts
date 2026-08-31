import type {
  OcrContext,
  OcrEngine,
  OcrResult,
  SttEngine,
  SttGateway,
} from "../types.js";

/**
 * Audio-as-page adapters. The router treats an audio document exactly like an
 * image: the bytes are the single "page" handed to a page-image engine
 * (`renderPageImages` returns `[bytes]` for every non-PDF kind), and the winner's
 * output is tagged `source: "stt"`. These two thin adapters are what let STT
 * flow through `executeRoute`'s unchanged machinery:
 *
 *   - `createSttGatewayEngine` wraps an injected {@link SttGateway} (external tier)
 *     under the `"stt-gateway"` engine tag;
 *   - `sttEngineAsOcr` wraps a local {@link SttEngine} (Moonshine) under the
 *     `"moonshine"` tag.
 *
 * Failures propagate as rejections by design: `executeRoute` catches per-page
 * engine errors into warnings and falls through to the next strategy — the same
 * contract every other OcrEngine already lives by. The gateways/engines
 * themselves additionally honor the resolve-`{text:""}`-never-throw contract, so
 * a graceful under-yield also just falls through.
 */

/**
 * Wrap an injected {@link SttGateway} as an {@link OcrEngine} so an audio
 * document's external-transcription leg runs as a normal routed strategy.
 * Wired by `buildRouteDeps` when `ParseOptions.stt` is present.
 */
export function createSttGatewayEngine(
  gateway: SttGateway,
  language?: "en" | "ar",
): OcrEngine {
  return {
    name: "stt-gateway",
    available: true,
    async recognize(audio: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      const out = await gateway.transcribe(audio, { signal: ctx.signal, language });
      return { text: (out?.text ?? "").trim(), confidence: out?.confidence };
    },
  };
}

/**
 * Wrap a local {@link SttEngine} (Moonshine) as an {@link OcrEngine} under the
 * `"moonshine"` tag. Internal — consumers register the SttEngine itself via
 * `setBrowserSttEngine` or inject it as `ParseOptions.sttEngine`; this adapter is
 * what the pipeline/worker put on the route deps.
 */
export function sttEngineAsOcr(engine: SttEngine, language?: "en" | "ar"): OcrEngine {
  return {
    name: engine.name,
    available: engine.available,
    async recognize(audio: Uint8Array, ctx: OcrContext): Promise<OcrResult> {
      const out = await engine.transcribe(audio, { signal: ctx.signal, language });
      return { text: (out?.text ?? "").trim(), confidence: out?.confidence };
    },
  };
}
