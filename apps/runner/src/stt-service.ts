import {
  createServerSttGateway,
  DEFAULT_STT_MODEL,
  ESCALATION_STT_MODEL,
  sttFloorFor,
  type SttLanguage,
  type SttResult,
} from "@drmoyassine/liteparse";
import {
  createMoonshineServerEngine,
  parseWavPcm16,
  WavError,
  type MoonshineServerEngine,
  type MoonshineServerOptions,
} from "@drmoyassine/liteparse/stt/moonshine-server";
import type { RequestedTranscribeOptions } from "./types.js";

/**
 * The /transcribe escalation walk (ROADMAP Track 3):
 *
 *   WAV pre-flight ─► slot 1 moonshine(lang) ─ conf ≥ floor ─► done
 *                        │ under floor / unavailable
 *                        ├─ en ─► slot 2 moonshine-base-en ─ conf ≥ floor ─► done
 *                        └─ ar ───────────────────────────────────┐
 *                                                                  ▼
 *                    caller SttGateway (options.stt) ─► done / best-effort + honest warning
 *
 * Mirrors createLiteparseService: engines are lazy singletons (createMoonshineServerEngine
 * already shares one ort + model-cache singleton across every engine object), the service
 * applies the confidence gate (the engine never gates itself), and every failure is a
 * warning — never a thrown error unless NOTHING can run (503) or the audio isn't WAV (422).
 */

/** Typed service failure with the HTTP status the handler must return. */
export class TranscribeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TranscribeHttpError";
  }
}

export interface SttServiceResult {
  text: string;
  language: SttLanguage;
  /** Model id that produced the text, or "stt-gateway". */
  engine: string;
  /** Honest local confidence; null when the external gateway produced the text. */
  confidence: number | null;
  warnings: string[];
}

export interface SttService {
  transcribe(
    bytes: Uint8Array,
    filename: string | undefined,
    options: RequestedTranscribeOptions | undefined,
    signal?: AbortSignal,
  ): Promise<SttServiceResult>;
  /** Preload the slot-1 EN model so the first request doesn't pay the load. */
  warm(): Promise<void>;
}

export interface SttServiceDeps {
  /** Explicit Moonshine models dir; undefined → the engine probes (env/cwd). */
  modelPath?: string;
  /** Test seam — defaults to createMoonshineServerEngine. */
  createEngine?: (opts: MoonshineServerOptions) => Promise<MoonshineServerEngine>;
}

/** One local decode attempt that completed (never an unavailable slot). */
interface SlotAttempt {
  modelId: string;
  result: SttResult;
}

export function createSttService(deps: SttServiceDeps = {}): SttService {
  const createEngine = deps.createEngine ?? ((opts) => createMoonshineServerEngine(opts));
  const modelPath = deps.modelPath;

  return {
    async transcribe(bytes, filename, options = {}, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const language: SttLanguage = options.language === "ar" ? "ar" : "en";
      const warnings: string[] = [];
      const attempts: SlotAttempt[] = [];

      // ── WAV pre-flight: the runner's contract is WAV PCM16 (browsers decode
      // webm/opus client-side via decodeAudioData → encodeWavPcm16 → POST WAV).
      // Checked BEFORE any model loads so a contract violation is a cheap 422,
      // not a slot-unavailable warning. parseWavPcm16 comes from the SAME
      // subpath chunk as the engine (see its re-export note) or this instanceof
      // would compare two different classes.
      try {
        parseWavPcm16(bytes);
      } catch (err) {
        if (err instanceof WavError) {
          throw new TranscribeHttpError(
            422,
            `audio is not WAV PCM16 (${err.code}: ${err.message}) — the runner contract is ` +
              `WAV PCM16 (mono 16 kHz ideal; other rates/channels are mixed + resampled). ` +
              `Decode client-side (decodeAudioData → encodeWavPcm16) and POST the WAV.`,
          );
        }
        throw err;
      }

      // ── local slots: slot 1 per language, slot 2 (EN only) = strictly stronger model.
      const slots = [DEFAULT_STT_MODEL[language]];
      if (ESCALATION_STT_MODEL[language]) slots.push(ESCALATION_STT_MODEL[language]!);

      for (const modelId of slots) {
        try {
          // Engines are thin closures over the shared model-cache singleton, so
          // per-request construction (for the per-request keepDiacritics flag)
          // costs nothing; the forced model makes the slot explicit.
          const engine = await createEngine({
            modelPath,
            model: modelId,
            keepDiacritics: options.keepDiacritics === true,
          });
          const result = await engine.transcribe(bytes, { language, filename, signal });
          if (signal?.aborted) throw new Error("aborted");
          attempts.push({ modelId, result });

          const floor = sttFloorFor(modelId);
          const conf = result.confidence ?? 0;
          if (result.text.trim() !== "" && conf >= floor) {
            return { text: result.text, language, engine: modelId, confidence: result.confidence ?? null, warnings };
          }
          warnings.push(
            result.text.trim() === ""
              ? `${modelId}: empty transcript`
              : `${modelId}: confidence ${conf.toFixed(2)} below floor ${floor}`,
          );
        } catch (err) {
          if (signal?.aborted) throw new Error("aborted");
          warnings.push(`${modelId} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── slot 3: the caller's external gateway (AR's only escalation).
      const gw = options.stt;
      if (gw) {
        const gateway = createServerSttGateway({
          endpoint: gw.endpoint,
          apiKey: gw.apiKey,
          model: gw.model,
          keyHeader: gw.keyHeader,
          temperature: gw.temperature,
          language,
        });
        try {
          const result = await gateway.transcribe(bytes, { language, filename, signal });
          if (result.text.trim() !== "") {
            return {
              text: result.text,
              language,
              engine: "stt-gateway",
              confidence: result.confidence ?? null,
              warnings,
            };
          }
          warnings.push("stt-gateway returned no text");
        } catch (err) {
          if (signal?.aborted) throw new Error("aborted");
          warnings.push(`stt-gateway failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── nothing cleared its floor: best-effort local text + honest warning.
      if (attempts.length > 0) {
        const best = attempts.reduce((a, b) =>
          (b.result.text.trim() !== "" ? (b.result.confidence ?? 0) : -1) >
          (a.result.text.trim() !== "" ? (a.result.confidence ?? 0) : -1)
            ? b
            : a,
        );
        warnings.push(
          gw
            ? "returning best-effort local transcription — no slot cleared its confidence floor and the gateway returned nothing"
            : "returning best-effort local transcription — no slot cleared its confidence floor and no options.stt gateway was configured",
        );
        return {
          text: best.result.text,
          language,
          engine: best.modelId,
          confidence: best.result.confidence ?? null,
          warnings,
        };
      }

      throw new TranscribeHttpError(
        503,
        `local STT unavailable and no gateway transcript was available — ${warnings.join("; ")}`,
      );
    },

    async warm() {
      const engine = await createEngine({ modelPath });
      await engine.warm("en");
    },
  };
}
