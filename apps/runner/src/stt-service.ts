import {
  createServerSttGateway,
  DEFAULT_STT_MODEL,
  ESCALATION_STT_MODEL,
  pickAutoLanguage,
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
import { looksLikeOggOpus, transcodeToWav } from "./audio-transcode.js";
import type { RequestedTranscribeOptions } from "./types.js";

/**
 * The /transcribe escalation walk (ROADMAP Track 3):
 *
 *   language:"auto" ─► dual slot-1 decode (tiny-en + tiny-ar) ─ script/degeneracy/
 *                        confidence evidence picks the language
 *                        ▼
 *   WAV pre-flight ─► slot 1 moonshine(lang) ─ conf ≥ floor ─► done
 *                        │ under floor / unavailable
 *                        ├─ en ─► slot 2 moonshine-base-en ─ conf ≥ floor ─► done
 *                        └─ ar ───────────────────────────────────┐
 *                                                                  ▼
 *                    caller SttGateway (options.stt) ─► done / best-effort + honest warning
 *
 * Auto is the default (WhatsApp voice notes are mixed en/ar and callers like
 * masteragent send no hint — DEC-087 amendment): an explicit "en" skips the
 * dual decode; the winner of the auto pick enters the walk as an
 * already-tried slot, so escalation continues exactly as before.
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

  /** One forced-model decode (auto mode's dual slot-1); null + warning when the slot can't run. */
  async function decodeSlot(
    modelId: string,
    language: SttLanguage,
    bytes: Uint8Array,
    filename: string | undefined,
    options: RequestedTranscribeOptions,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<SlotAttempt | null> {
    try {
      const engine = await createEngine({
        modelPath,
        model: modelId,
        keepDiacritics: options.keepDiacritics === true,
      });
      const result = await engine.transcribe(bytes, { language, filename, signal });
      if (signal?.aborted) throw new Error("aborted");
      return { modelId, result };
    } catch (err) {
      if (signal?.aborted) throw new Error("aborted");
      warnings.push(`${modelId} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  return {
    async transcribe(bytes, filename, options = {}, signal) {
      if (signal?.aborted) throw new Error("aborted");
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
          // TASK-221: channel voice notes are Ogg Opus (WhatsApp standard) and
          // server callers have no AudioContext — transcode locally via the
          // bundled ffmpeg (audio never leaves the box) instead of bouncing a
          // 422. The old WASM attempt (ogg-opus-decoder) was disqualified: it
          // silently returned zero frames on real voice notes.
          try {
            const wasOggOpus = looksLikeOggOpus(bytes);
            const t = await transcodeToWav(bytes);
            bytes = t.wav;
            warnings.push(
              `transcoded: ${wasOggOpus ? "ogg/opus" : "compressed audio"} → ` +
                `wav pcm16 locally (${t.durationMs} ms audio)`,
            );
          } catch (te) {
            throw new TranscribeHttpError(
              422,
              `audio transcode failed (${te instanceof Error ? te.message : String(te)}) — ` +
                `the runner contract is WAV PCM16, and the bundled ffmpeg could ` +
                `not decode the stream`,
            );
          }
        } else {
          throw err;
        }
      }

      // ── language: "auto" (the default) dual-decodes BOTH slot-1 tiny models
      // and picks per pickAutoLanguage; the winner enters the walk as an
      // already-tried slot, so escalation continues exactly as an explicit
      // language would. An explicit "en"/"ar" skips the dual decode entirely.
      const requested: SttLanguage | "auto" = options.language ?? "auto";
      const triedModels = new Set<string>();
      let language: SttLanguage;

      if (requested === "auto") {
        const [en, ar] = await Promise.all([
          decodeSlot(DEFAULT_STT_MODEL.en, "en", bytes, filename, options, warnings, signal),
          decodeSlot(DEFAULT_STT_MODEL.ar, "ar", bytes, filename, options, warnings, signal),
        ]);
        // Shared evidence pick (package stt/auto.ts) over the two attempts.
        const pick = pickAutoLanguage(en?.result ?? null, ar?.result ?? null);
        language = pick.language;
        const winner = pick.language === "en" ? en : ar;
        if (winner) {
          triedModels.add(winner.modelId);
          attempts.push(winner);
          const floor = sttFloorFor(winner.modelId);
          const conf = winner.result.confidence ?? 0;
          if (winner.result.text.trim() !== "" && conf >= floor) {
            warnings.push(`auto: picked ${language} — ${pick.reason}`);
            return {
              text: winner.result.text,
              language,
              engine: winner.modelId,
              confidence: winner.result.confidence ?? null,
              warnings,
            };
          }
          warnings.push(
            `auto: picked ${language} — ${pick.reason}; winner under floor ` +
              `${conf.toFixed(2)} < ${floor}, escalating`,
          );
        } else {
          // Both slots failed to RUN — continue as en so the walk still
          // reaches the gateway (its slots re-fail with their own warnings).
          warnings.push(`auto: ${pick.reason}`);
        }
      } else {
        language = requested;
      }

      // ── local slots: slot 1 per language (already tried in auto mode),
      // slot 2 (EN only) = strictly stronger model.
      const slots = [DEFAULT_STT_MODEL[language]];
      if (ESCALATION_STT_MODEL[language]) slots.push(ESCALATION_STT_MODEL[language]!);

      for (const modelId of slots) {
        if (triedModels.has(modelId)) continue;
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
      // Both slot-1 models: the first AR voice note must not pay the load
      // (six extra graphs load once at boot — they're in the image already).
      await engine.warm("en");
      await engine.warm("ar");
    },
  };
}
