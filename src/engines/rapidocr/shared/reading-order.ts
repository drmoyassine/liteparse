/**
 * Reading-order sort shared by every RapidOCR runtime.
 *
 * Detection returns boxes in SCORE order, which scrambles the line sequence (e.g. a bullet
 * point outscores the title and prints first). Boxes on the same visual line have near-equal
 * top edges (grouped by the 5px tolerance); distinct text lines are tens of px apart, so the
 * tolerance cleanly separates them. The result reads top-to-bottom, left-to-right.
 */

/** Minimal box shape the sort needs — satisfied by any {@link ../shared/quality.TextBox}. */
export interface ReadingOrderBox {
  points: number[][];
}

/** Sort a copy of `boxes` into reading order (top-to-bottom, then left-to-right). */
export function readingOrderSort<T extends ReadingOrderBox>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => {
    const topA = Math.min(...a.points.map((p) => p[1]!));
    const topB = Math.min(...b.points.map((p) => p[1]!));
    if (Math.abs(topA - topB) > 5) return topA - topB; // different lines → top first
    const leftA = Math.min(...a.points.map((p) => p[0]!));
    const leftB = Math.min(...b.points.map((p) => p[0]!));
    return leftA - leftB; // same line → left first
  });
}
