/**
 * Writing-system (script) detection and the "Latin + 1 dynamic" browser-language
 * cap for the Intelligent Document Router.
 *
 * Pure logic — no I/O, fully unit-testable. The browser ships one recognition
 * model permanently (Latin, which covers en/es/it/fr/de + ~30 others in a single
 * model) and may load **at most one** additional script model on demand; the
 * previous dynamic script is evicted to the edge so only two scripts ever live
 * in-browser at once. See ARCHITECTURE.md → Language Strategy.
 *
 * Detection is language-agnostic (one model per script); recognition is per
 * script. {@link scriptToRecModel} hands the route layer the logical PaddleOCR /
 * RapidOCR recognition model id for a detected script — the exact model filename
 * is the injected runner's concern, not ours (see `ocr/rapidocr.ts`).
 */

import type { Script } from "./types.js";

/** The always-loaded browser script. Never appears in `offloadToEdge`. */
export const LATIN: Script = "latin";

/**
 * Plan for which recognition models the browser should load / evict after
 * classifying a document, given what is already in the model cache.
 *
 * `load`     — scripts to fetch into the browser cache now.
 * `offloadToEdge` — non-Latin scripts to evict from the browser cache (route
 *                   them via the edge service instead) to honour the "Latin + 1"
 *                   cap. Latin is permanent and never appears here.
 */
export interface LanguagePlan {
  load: Script[];
  offloadToEdge: Script[];
}

/**
 * Classify a single Unicode code point into a writing-system family, or `null`
 * if it does not count toward any family (whitespace, punctuation, digits,
 * symbols, or a script liteparse does not model).
 *
 * Ranges (Unicode code points):
 *   - Latin: basic letters (A–Z, a–z) + Latin-1 Supplement letters (U+00C0–U+00FF,
 *     excluding the symbols × U+00D7 and ÷ U+00F7) + Latin Extended-A/B
 *     (U+0100–U+024F).
 *   - Arabic:      U+0600–U+06FF
 *   - Cyrillic:    U+0400–U+04FF
 *   - CJK:         U+4E00–U+9FFF (Unified) + U+3040–U+309F (Hiragana)
 *                  + U+30A0–U+30FF (Katakana) + U+AC00–U+D7AF (Hangul)
 *   - Devanagari:  U+0900–U+097F
 */
function classifyCodePoint(cp: number): Script | null {
  // Latin — basic + Latin-1 Supplement letters + Latin Extended-A/B.
  if (
    (cp >= 0x41 && cp <= 0x5a) || // A–Z
    (cp >= 0x61 && cp <= 0x7a) || // a–z
    (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7) || // À–ÿ minus × ÷
    (cp >= 0x100 && cp <= 0x24f) // Latin Extended-A (0100–017F) + Extended-B (0180–024F)
  ) {
    return "latin";
  }
  if (cp >= 0x600 && cp <= 0x6ff) return "arabic"; // Arabic
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic"; // Cyrillic
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul Syllables
  ) {
    return "cjk";
  }
  if (cp >= 0x900 && cp <= 0x97f) return "devanagari"; // Devanagari
  return null; // whitespace, punctuation, digits, symbols, unmapped scripts
}

/**
 * Detect the dominant writing system in `text` by tallying characters per
 * family. Iterates by Unicode code point (`for…of` is code-point-aware on
 * strings, so astral / surrogate-pair characters are counted once each).
 *
 * Decision rule:
 *   - Find the family with the most counted characters. If it is a **non-Latin**
 *     family with **at least 2** counted characters, return it.
 *   - Otherwise, if any Latin character was seen, return `"latin"` (Latin is the
 *     always-available browser default; on ties Latin wins so we avoid loading
 *     an unnecessary model).
 *   - Otherwise return `"unknown"` (empty input, or only digits/punctuation).
 *
 * Whitespace, punctuation, and digits do not count toward any family.
 */
export function detectScript(text: string): Script {
  const counts: Partial<Record<Script, number>> = {};

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const fam = classifyCodePoint(cp);
    if (fam === null) continue;
    counts[fam] = (counts[fam] ?? 0) + 1;
  }

  // Tally order with Latin first so Latin wins ties (conservative: prefer the
  // already-loaded model over an extra download).
  const familyOrder: Script[] = ["latin", "arabic", "cyrillic", "cjk", "devanagari"];
  let maxFam: Script | null = null;
  let maxCount = 0;
  for (const fam of familyOrder) {
    const c = counts[fam] ?? 0;
    if (c > maxCount) {
      maxCount = c;
      maxFam = fam;
    }
  }

  if (maxFam !== null && maxFam !== "latin" && maxCount >= 2) {
    return maxFam;
  }
  if ((counts.latin ?? 0) > 0) return "latin";
  return "unknown";
}

/**
 * Map a detected script to its logical PaddleOCR / RapidOCR recognition model
 * id, or `null` if there is no first-class model (so the router should not try
 * to run RapidOCR recognition for it and should pick another strategy).
 *
 * These are logical ids only; the injected runner resolves them to real model
 * filenames / ONNX assets.
 */
export function scriptToRecModel(script: Script): string | null {
  switch (script) {
    case "latin":
      return "en";
    case "arabic":
      return "ar";
    case "cyrillic":
      return "ru";
    case "cjk":
      return "zh";
    case "devanagari":
      return "hi";
    case "other":
    case "unknown":
      return null;
  }
}

/**
 * Implement the ARCHITECTURE "Latin + 1 dynamic" browser-language cap.
 *
 * `cached` is the set of scripts already present in the browser model cache; it
 * always includes Latin. Rules:
 *   - Latin is permanent: it NEVER appears in `offloadToEdge`.
 *   - If `detected` is `"latin"` or `"unknown"`: nothing to do (Latin covers it,
 *     or there is no signal) → `{ load: [], offloadToEdge: [] }`.
 *   - If `detected` is non-Latin and already in `cached`: it is available → no-op.
 *   - Otherwise (non-Latin, not cached): load `detected`, and offload every
 *     non-Latin script currently in `cached` that is not `detected` — evicting
 *     the previous dynamic script(s) so at most ONE non-Latin script stays
 *     alongside Latin.
 */
export function decideBrowserLanguages(detected: Script, cached: Script[]): LanguagePlan {
  if (detected === "latin" || detected === "unknown") {
    return { load: [], offloadToEdge: [] };
  }
  if (cached.includes(detected)) {
    return { load: [], offloadToEdge: [] };
  }
  const offloadToEdge = cached.filter((s) => s !== "latin" && s !== detected);
  return { load: [detected], offloadToEdge };
}
