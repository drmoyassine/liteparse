import type { SttResult } from "../types.js";
import type { SttLanguage } from "../engines/moonshine/shared/models.js";

/**
 * The language:"auto" core — shared by the browser engine, the server engine,
 * and the runner's escalation walk. Moonshine is per-language (tiny-en cannot
 * emit Arabic script; tiny-ar's Latin readings of English are weak), so auto
 * means: dual slot-1 decode, then pick by evidence.
 *
 * The evidence rules exist because greedy per-token confidence does NOT catch
 * the failure mode — a looping decoder is confident. A real 2026-10-22 Arabic
 * voice note through the EN model returned "So, I have a question." ×10 at
 * confidence 0.9, so language selection needs its own signals: script
 * presence, decode degeneracy, and only then confidence.
 */

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;

/**
 * Degenerate-decode detector — the repetition-loop signature. Conservative on
 * purpose: ≥12 words AND <35% unique words, so short legit replies
 * ("yes yes I will send it") never trip it.
 */
export function isDegenerate(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  return new Set(words).size / words.length < 0.35;
}

/** The auto pick: which language won, and the evidence string for telemetry. */
export interface AutoPick {
  language: SttLanguage;
  reason: string;
}

/**
 * Language pick from the two slot-1 attempts (a slot that couldn't RUN loses
 * to one that did — its failure is reported via onSlotError). Rules, in order:
 *
 *   1. both decodes degenerate (no script signal left) → higher confidence wins
 *   2. AR decode carries Arabic script → ar (tiny-en's vocab has no Arabic
 *      script, so its presence is positive evidence the clip is Arabic — even
 *      when the AR decode itself loops; the caller's floor/gateway then judges it)
 *   3. EN degenerate, AR clean → ar (a looping EN decode is worthless; the
 *      Latin-script Arabic/dialect reading beats it)
 *   4. AR degenerate (no Arabic script), EN clean → en
 *   5. both clean, no Arabic script → en (the status-quo default)
 */
export function pickAutoLanguage(en: SttResult | null, ar: SttResult | null): AutoPick {
  if (!en && !ar) return { language: "en", reason: "no local slot-1 decode ran" };
  if (!ar) return { language: "en", reason: "AR slot unavailable" };
  if (!en) return { language: "ar", reason: "EN slot unavailable" };

  const enConf = en.confidence ?? 0;
  const arConf = ar.confidence ?? 0;
  const enDegenerate = isDegenerate(en.text);
  const arDegenerate = isDegenerate(ar.text);
  const arHasArabicScript = ARABIC_SCRIPT.test(ar.text);

  if (enDegenerate && arDegenerate) {
    return enConf >= arConf
      ? {
          language: "en",
          reason: `both decodes degenerate — higher confidence wins (EN ${enConf.toFixed(2)} vs AR ${arConf.toFixed(2)})`,
        }
      : {
          language: "ar",
          reason: `both decodes degenerate — higher confidence wins (AR ${arConf.toFixed(2)} vs EN ${enConf.toFixed(2)})`,
        };
  }
  if (arHasArabicScript) {
    return {
      language: "ar",
      reason: `Arabic script in AR decode (EN ${enConf.toFixed(2)}, AR ${arConf.toFixed(2)})`,
    };
  }
  if (enDegenerate) {
    return {
      language: "ar",
      reason: `EN decode degenerate (repetition loop, ${enConf.toFixed(2)}); AR decode clean (${arConf.toFixed(2)})`,
    };
  }
  if (arDegenerate) {
    return {
      language: "en",
      reason: `AR decode degenerate (repetition loop, ${arConf.toFixed(2)}); EN decode clean (${enConf.toFixed(2)})`,
    };
  }
  return {
    language: "en",
    reason: `no Arabic script in AR decode (EN ${enConf.toFixed(2)}, AR ${arConf.toFixed(2)})`,
  };
}

export interface TranscribeAutoHooks {
  /** Called with the pick before the winner is returned (telemetry seam). */
  onPick?: (pick: AutoPick) => void;
  /** Called per slot that could not run (its error becomes a null attempt). */
  onSlotError?: (language: SttLanguage, err: unknown) => void;
  /** Abort between/before slots; a slot-internal abort rethrows, never nulls. */
  signal?: AbortSignal;
}

/**
 * Dual slot-1 decode (EN + AR, in parallel — the decodes are independent) with
 * the shared evidence pick. The winner comes back with `language` normalized
 * to the pick (the winner's own decode already reports that language for the
 * Moonshine engines). One null slot is fine — pickAutoLanguage rules handle
 * it; BOTH null throws so the caller's failure contract is preserved.
 */
export async function transcribeAuto(
  decode: (language: SttLanguage) => Promise<SttResult>,
  hooks: TranscribeAutoHooks = {},
): Promise<SttResult & { language: SttLanguage }> {
  if (hooks.signal?.aborted) throw new Error("aborted");
  const errors: string[] = [];
  const settle = async (language: SttLanguage): Promise<SttResult | null> => {
    try {
      return await decode(language);
    } catch (err) {
      if (hooks.signal?.aborted) throw new Error("aborted");
      errors.push(`${language}: ${err instanceof Error ? err.message : String(err)}`);
      hooks.onSlotError?.(language, err);
      return null;
    }
  };
  const [en, ar] = await Promise.all([settle("en"), settle("ar")]);
  const pick = pickAutoLanguage(en, ar);
  hooks.onPick?.(pick);
  const winner = pick.language === "en" ? en : ar;
  if (!winner) {
    // Both slots failed to RUN — surface their errors (a both-null throw must
    // carry the underlying cause, e.g. "no ModelOrigin configured" or the
    // missing-model file list, not just the auto summary).
    throw new Error(`auto language detection failed — neither slot-1 decode ran — ${errors.join("; ")}`);
  }
  return { ...winner, language: pick.language };
}
