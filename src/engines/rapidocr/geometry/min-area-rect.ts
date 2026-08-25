/**
 * Minimum-area rectangle + mini-boxes for DB post-processing.
 *
 * Pure geometry — no DOM, no worker globals, no onnxruntime imports. Runs under
 * both the browser worker and jest/jsdom.
 *
 * This is a faithful TypeScript port of the OpenCV `cv2.minAreaRect` primitive
 * and PaddleOCR's `get_mini_boxes` (ppocr/postprocess/db_postprocess.py, release/2.7).
 * The min-area enclosing rectangle of a convex polygon always has one side
 * collinear with an edge of the polygon (rotating-calipers theorem), so we
 * project the hull onto each edge direction and keep the orientation with the
 * smallest bounding area — exactly mirroring cv2.minAreaRect.
 *
 * Reference:
 * - PaddleOCR db_postprocess.py:
 *   https://github.com/PaddlePaddle/PaddleOCR/blob/release/2.7/ppocr/postprocess/db_postprocess.py
 */

/** A 2D point as an [x, y] tuple. */
type Pt = readonly [number, number];

/** Result of {@link minAreaRect}: the 4 corners of the enclosing rectangle (any order) plus extents. */
export interface MinAreaRect {
  corners: [number, number][];
  width: number;
  height: number;
}

/** Result of {@link getMiniBoxes}: ordered [TL, TR, BR, BL] box and the short side length. */
export interface MiniBox {
  box: [number, number][];
  sside: number;
}

/**
 * Compute the convex hull of a point set using Andrew's monotone chain.
 *
 * Self-contained (do not import from elsewhere — other geometry modules depend
 * on this file). Returns the hull vertices in counter-clockwise order with no
 * collinear points on the edges. For fewer than 2 unique points returns the
 * input (degenerate); for all-collinear input returns the 2 extreme endpoints.
 */
function convexHull(points: Pt[]): Pt[] {
  if (points.length <= 1) return points.slice();

  // Sort by (x, then y) lexicographically.
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  // 2D cross product of vectors O->A and O->B.
  // > 0 => A->B is a left turn (CCW); < 0 => right turn; 0 => collinear.
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  // Lower hull.
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  // Upper hull.
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  // Concatenate, dropping the last vertex of each half (it repeats the first of
  // the other).
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Compute the minimum-area enclosing rectangle of a point set.
 *
 * Mirrors `cv2.minAreaRect`: the returned `corners` are the 4 vertices of the
 * tightest axis-aligned-in-its-own-frame rectangle (any order), and
 * `width`/`height` are its extents along the rectangle's two axes.
 *
 * Degenerate inputs:
 *   - Fewer than 2 unique points -> corners = [p, p, p, p], width = 0, height = 0.
 *   - All collinear (hull is a segment) -> width = segment length, height = 0,
 *     corners laid along the segment.
 *
 * @param pts - input points (any array-like of [x, y] tuples)
 */
export function minAreaRect(pts: ReadonlyArray<Pt>): MinAreaRect {
  // Deduplicate (by value) so identical inputs collapse cleanly.
  const seen = new Set<string>();
  const unique: Pt[] = [];
  for (const p of pts) {
    const key = p[0] + "," + p[1];
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  // <2 unique points: fully degenerate.
  if (unique.length < 2) {
    const c: [number, number] = unique.length === 1 ? [unique[0]![0], unique[0]![1]] : [0, 0];
    return { corners: [c, c, c, c], width: 0, height: 0 };
  }

  const hull = convexHull(unique);

  // 2-point hull: input is collinear (the hull collapsed to a segment). The
  // enclosing rectangle is a degenerate flat segment of that length.
  if (hull.length < 3) {
    const a = hull[0]!;
    const b = hull[1]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const a2: [number, number] = [a[0], a[1]];
    const b2: [number, number] = [b[0], b[1]];
    return { corners: [a2, b2, b2, a2], width: seg, height: 0 };
  }

  // For each hull edge, project all hull points onto (edge dir, perp) and take
  // the axis-aligned extents. Track the orientation with the minimum area.
  let bestArea = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  let bestNx = 0;
  let bestNy = 0;
  let bestUmin = 0;
  let bestUmax = 0;
  let bestVmin = 0;
  let bestVmax = 0;

  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % n]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue; // zero-length edge (shouldn't happen post-dedupe)
    const dx = ex / len;
    const dy = ey / len;
    // Unit perpendicular (left of the edge dir).
    const nx = -dy;
    const ny = dx;

    let umin = Infinity;
    let umax = -Infinity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const p of hull) {
      const u = p[0] * dx + p[1] * dy;
      const v = p[0] * nx + p[1] * ny;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }

    const w = umax - umin;
    const h = vmax - vmin;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      bestDx = dx;
      bestDy = dy;
      bestNx = nx;
      bestNy = ny;
      bestUmin = umin;
      bestUmax = umax;
      bestVmin = vmin;
      bestVmax = vmax;
    }
  }

  // Reconstruct the 4 corners from the best orientation. In uv they are the
  // rectangle (umin,vmin),(umax,vmin),(umax,vmax),(umin,vmax); convert each back
  // to xy via x = u*dx + v*nx, y = u*dy + v*ny.
  const corners: [number, number][] = [
    [bestUmin * bestDx + bestVmin * bestNx, bestUmin * bestDy + bestVmin * bestNy],
    [bestUmax * bestDx + bestVmin * bestNx, bestUmax * bestDy + bestVmin * bestNy],
    [bestUmax * bestDx + bestVmax * bestNx, bestUmax * bestDy + bestVmax * bestNy],
    [bestUmin * bestDx + bestVmax * bestNx, bestUmin * bestDy + bestVmax * bestNy],
  ];

  const width = bestUmax - bestUmin;
  const height = bestVmax - bestVmin;
  return { corners, width, height };
}

/**
 * Get the minimum-area box of a contour, ordered as [TL, TR, BR, BL], plus the
 * short side length.
 *
 * Faithful port of PaddleOCR's `get_mini_boxes`:
 *   1. Compute the min-area rect of the contour.
 *   2. Sort the 4 corner points by x ascending (stable).
 *   3. Of the two leftmost points (indices 0,1), the one with the smaller y is
 *      the top-left (index_1); the larger y is the bottom-left (index_4). Of the
 *      two rightmost points (indices 2,3), the smaller y is the top-right
 *      (index_2); the larger y is the bottom-right (index_3).
 *   4. Return [TL, TR, BR, BL] and min(width, height).
 *
 * (Image coords are y-down, so "smaller y" = "top".)
 *
 * @param contour - input contour points
 */
export function getMiniBoxes(contour: ReadonlyArray<Pt>): MiniBox {
  const { corners, width, height } = minAreaRect(contour);

  // Sort by x ascending. Array.prototype.sort is stable in modern engines, so
  // equal-x pairs keep their input order — matching Python's stable sorted().
  const pts = corners.slice().sort((a, b) => a[0] - b[0]);

  let i1: number;
  let i2: number;
  let i3: number;
  let i4: number;
  if (pts[1]![1] > pts[0]![1]) {
    i1 = 0;
    i4 = 1;
  } else {
    i1 = 1;
    i4 = 0;
  }
  if (pts[3]![1] > pts[2]![1]) {
    i2 = 2;
    i3 = 3;
  } else {
    i2 = 3;
    i3 = 2;
  }

  const box: [number, number][] = [
    [pts[i1]![0], pts[i1]![1]],
    [pts[i2]![0], pts[i2]![1]],
    [pts[i3]![0], pts[i3]![1]],
    [pts[i4]![0], pts[i4]![1]],
  ];

  return { box, sside: Math.min(width, height) };
}
