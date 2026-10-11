/**
 * Text-layer quality check for native PDF pages (and OCR re-reads, so the two can
 * be compared). Catches corrupted text layers: replacement characters, private-use
 * / control glyphs, symbols or stray digits inside words, and UTF-8-read-as-Latin-1
 * mojibake. A letter swapped for another letter ("Accrtditation") is NOT detectable
 * here — that needs the optional dictionary check.
 */

export interface TextQuality {
  /** 0 (garbage) – 1 (clean). */
  score: number;
  suspect: boolean;
  reasons: string[];
}

const PUA = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const MOJIBAKE = /Ã[\u0080-\u00BF]|Ø[\u00A7-\u00BF]|Ù[\u0080-\u008A]|â€/g;
// Symbol (not letter/mark/digit/common joiners) sandwiched between letters.
const SYMBOL_IN_WORD = /\p{L}[^\p{L}\p{M}\p{N}\s'’\-.,/&_@:+#()\[\]"“”«»;!?|]+\p{L}/u;
const DIGIT_IN_WORD = /^\p{L}{2,}\p{N}\p{L}{2,}$/u;

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

/** Score a page's text. Thresholds are deliberately conservative (false positives cost an OCR pass). */
export function scoreTextLayer(text: string): TextQuality {
  const nonWs = text.replace(/\s/g, "").length;
  if (nonWs === 0) return { score: 0, suspect: false, reasons: [] };

  const replacement = count(/\uFFFD/g, text);
  const pua = count(PUA, text);
  const control = count(CONTROL, text);
  const mojibake = count(MOJIBAKE, text);

  let words = 0;
  let badWords = 0;
  for (const tok of text.split(/\s+/)) {
    if (!/\p{L}/u.test(tok)) continue;
    words++;
    if (/[@]|:\/\//.test(tok)) continue; // emails / URLs
    const core = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (SYMBOL_IN_WORD.test(core) || (core.length >= 6 && DIGIT_IN_WORD.test(core))) badWords++;
  }

  const reasons: string[] = [];
  const glyphBad = replacement + pua + control;
  if (replacement >= 3 || replacement / nonWs > 0.005) reasons.push(`replacement_chars:${replacement}`);
  if ((pua + control) / nonWs > 0.02) reasons.push(`private_or_control:${pua + control}`);
  if (mojibake >= 3) reasons.push(`mojibake:${mojibake}`);
  if (words >= 5 && badWords / words > 0.05) reasons.push(`symbols_in_words:${badWords}/${words}`);

  const weighted = glyphBad / Math.max(1, nonWs / 5) + (2 * mojibake + badWords) / Math.max(1, words);
  const score = Math.max(0, Math.min(1, 1 - weighted));
  return { score: Math.round(score * 1000) / 1000, suspect: reasons.length > 0, reasons };
}
