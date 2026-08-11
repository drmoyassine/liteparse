/**
 * Polygon offset (unclip) for DB post-processing.
 *
 * Pure geometry — no DOM, no worker globals, no onnxruntime imports. Runs under
 * jest/jsdom. Faithful port of PaddleOCR's `unclip` for the rectangle case.
 *
 * Reference: PaddleOCR release/2.7 `ppocr/postprocess/db_postprocess.py`:
 *   distance = poly.area * unclip_ratio / poly.length
 *   PyclipperOffset(JT_ROUND, ET_CLOSEDPOLYGON).Execute(distance)
 */

/** A 2D point as an [x, y] tuple. */
type Pt = readonly [number, number];

/** An offset edge stored as two shifted endpoints. */
interface OffsetEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Expand a 4-point rectangle outward by the PaddleOCR unclip distance.
 *
 * `distance = area * unclipRatio / perimeter` (PaddleOCR `db_postprocess.unclip`),
 * where the reference applies a Clipper round-join offset. Here we compute the
 * exact miter offset of the rectangle: each edge is shifted along its outward
 * normal by `distance`, and each new corner is the line-line intersection of two
 * adjacent shifted edges.
 *
 * NOTE: this is exact in this pipeline because `unclip` is ALWAYS called on the
 * 4-point rectangle returned by `getMiniBoxes` (never on a raw contour), and its
 * output is immediately re-passed to `getMiniBoxes`. For a rectangle, a miter
 * (edge-normal) offset and Clipper's JT_ROUND joins are bit-identical after the
 * second `getMiniBoxes` call — the round arc segments Clipper inserts at each
 * corner are discarded by the re-fit. For a general convex polygon this routine
 * would be a miter offset (a small gap vs Clipper JT_ROUND round joins), but that
 * case does not arise here.
 *
 * @param box - 4 corners of the getMiniBoxes rectangle, any consistent winding.
 * @param unclipRatio - expansion ratio (PaddleOCR default 1.5).
 * @returns 4 expanded corners; input vertex order preserved (out[i] corresponds to box[i]).
 */
export function unclipBox(
  box: ReadonlyArray<Pt>,
  unclipRatio: number
): [number, number][] {
  const n = box.length;
  if (n !== 4) {
    // Defensive: callers always pass a 4-point rectangle. Copy through if not.
    return box.map((p) => [p[0], p[1]] as [number, number]);
  }

  // Shoelace area (absolute).
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += box[i][0] * box[j][1] - box[j][0] * box[i][1];
  }
  const area = Math.abs(area2) / 2;

  // Perimeter = sum of the 4 edge lengths.
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    perimeter += Math.hypot(box[j][0] - box[i][0], box[j][1] - box[i][1]);
  }
  if (perimeter === 0) {
    return box.map((p) => [p[0], p[1]] as [number, number]);
  }

  // PaddleOCR unclip distance formula.
  const distance = (area * unclipRatio) / perimeter;

  // Centroid (average of vertices — exact for a rectangle).
  let cx = 0;
  let cy = 0;
  for (const p of box) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;

  // Shift each edge outward by `distance` along its outward normal.
  // offsetEdge[i] = { a', b' } where a' = box[i] + d*outward, b' = box[(i+1)%4] + d*outward.
  const offsetEdges: OffsetEdge[] = [];
  for (let i = 0; i < n; i++) {
    const a = box[i];
    const b = box[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const elen = Math.hypot(ex, ey);
    if (elen === 0) {
      // Degenerate zero-length edge — no offset possible.
      offsetEdges.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] });
      continue;
    }
    // Two candidate unit perpendiculars.
    const p1x = ey / elen;
    const p1y = -ex / elen;
    const p2x = -ey / elen;
    const p2y = ex / elen;
    // Edge midpoint.
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    // The outward normal is the one that moves the midpoint farther from the centroid.
    const d1 = (mx + p1x - cx) ** 2 + (my + p1y - cy) ** 2;
    const d2 = (mx + p2x - cx) ** 2 + (my + p2y - cy) ** 2;
    const ox = d1 > d2 ? p1x : p2x;
    const oy = d1 > d2 ? p1y : p2y;
    offsetEdges.push({
      ax: a[0] + distance * ox,
      ay: a[1] + distance * oy,
      bx: b[0] + distance * ox,
      by: b[1] + distance * oy,
    });
  }

  // New vertex[i] = line-line intersection of offsetEdges[(i-1+n)%n] and offsetEdges[i].
  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = offsetEdges[(i - 1 + n) % n];
    const cur = offsetEdges[i];
    result.push(lineIntersect(prev, cur));
  }
  return result;
}

/**
 * Intersection of two infinite lines, each given as two points on the line.
 *
 * Solves P1 + s*D1 = P2 + r*D2 (a standard 2D line-line intersection) and returns
 * P1 + s*D1. Falls back to the midpoint of the two anchor points when the lines
 * are (near-)parallel — degenerate for a valid rectangle offset and unreachable
 * in normal operation.
 *
 * @param e1 - first line as two points {a, b}.
 * @param e2 - second line as two points {a, b}.
 * @returns the intersection point [x, y].
 */
function lineIntersect(e1: OffsetEdge, e2: OffsetEdge): [number, number] {
  const d1x = e1.bx - e1.ax;
  const d1y = e1.by - e1.ay;
  const d2x = e2.bx - e2.ax;
  const d2y = e2.by - e2.ay;
  // det = D2.x*D1.y - D1.x*D2.y
  const det = d2x * d1y - d1x * d2y;
  if (Math.abs(det) < 1e-12) {
    // Parallel — return the midpoint of the two anchor points as a safe fallback.
    return [(e1.ax + e2.ax) / 2, (e1.ay + e2.ay) / 2];
  }
  // A = P2 - P1; s = (D2.x*Ay - Ax*D2.y) / det
  const ax = e2.ax - e1.ax;
  const ay = e2.ay - e1.ay;
  const s = (d2x * ay - ax * d2y) / det;
  return [e1.ax + s * d1x, e1.ay + s * d1y];
}
