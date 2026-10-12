/**
 * Arabic post-processing shared by the browser and server RapidOCR engines.
 */
import type { TextBox } from "./quality.js";

/** Arabic letters (not punctuation / digits). */
export const ARABIC_LETTER_RE = /[\u0621-\u064A\u0671-\u06D3]/;

/**
 * PaddleOCR `pred_reverse` for Arabic: the rec model emits characters in visual
 * (left-to-right image) order; reverse to logical order while keeping Latin/digit
 * runs intact.
 */
export function reverseArabic(pred: string): string {
  const parts: string[] = [];
  let run = "";
  for (const c of pred) {
    if (/[a-zA-Z0-9 :*./%+-]/.test(c)) run += c;
    else {
      if (run) parts.push(run);
      parts.push(c);
      run = "";
    }
  }
  if (run) parts.push(run);
  return parts.reverse().join("");
}

/** Arabic reading order: boxes on the same row (already top-to-bottom sorted) read right-to-left. */
export function rtlRows<T extends TextBox>(sorted: T[]): T[] {
  const rows: T[][] = [];
  const cy = (b: TextBox) => b.points.reduce((a, p) => a + p[1]!, 0) / b.points.length;
  const h = (b: TextBox) => Math.max(...b.points.map((p) => p[1]!)) - Math.min(...b.points.map((p) => p[1]!));
  for (const b of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(row[0]!) - cy(b)) < h(row[0]!) / 2) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.reverse());
}

/** Count Arabic letters in a string. */
export function arabicLetterCount(text: string): number {
  let n = 0;
  for (const c of text) if (ARABIC_LETTER_RE.test(c)) n++;
  return n;
}
