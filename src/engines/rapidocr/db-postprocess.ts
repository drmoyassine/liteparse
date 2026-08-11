/**
 * DB (Differentiable Binarization) post-processing for PP-OCR detection.
 *
 * Converts the detection model's probability map output into text bounding boxes.
 * This is a faithful TypeScript port of PaddleOCR release/2.7's
 * `boxes_from_bitmap` (ppocr/postprocess/db_postprocess.py): for each connected
 * component -> get_mini_boxes -> box_score_fast -> unclip -> get_mini_boxes, with
 * short-side and score filters at each stage and final coordinate scaling to the
 * destination (original-image) frame.
 *
 * References:
 * - "Real-Time Scene Text Detection with Differentiable Binarization" (DB paper)
 * - PaddleOCR release/2.7: https://github.com/PaddlePaddle/PaddleOCR/blob/release/2.7/ppocr/postprocess/db_postprocess.py
 */

import { getMiniBoxes } from "./geometry/min-area-rect";
import { unclipBox } from "./geometry/polygon-offset";
import { boxScoreFast } from "./geometry/polygon-fill";

/**
 * 2D point
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Text box polygon
 */
interface TextBox {
  points: number[][];  // 4 points [[x,y], ...]
  score: number;       // detection confidence
}

/**
 * DB post-processing parameters
 *
 * PaddleOCR uses TWO distinct thresholds — conflating them is the classic "zero boxes"
 * bug: binarizing pixels at 0.6 leaves almost no foreground, so no connected components
 * ever form.
 *   - `binarizeThreshold` (PaddleOCR `thresh`, ~0.3): per-pixel cutoff on the prob map.
 *   - `boxThreshold` (PaddleOCR `box_thresh`, ~0.6): keep a box only if the mean prob
 *     over its region exceeds this.
 */
export interface DBParams {
  binarizeThreshold: number; // per-pixel binarization cutoff (PaddleOCR `thresh`, ~0.3)
  boxThreshold: number;      // box-level mean-prob keep cutoff (PaddleOCR `box_thresh`, ~0.6)
  unclipRatio: number;       // ratio for expanding polygons (PaddleOCR default 1.5)
  maxCandidates: number;     // max number of boxes to return
  minBoxSize: number;        // minimum box short-side length in prob-map pixels (PaddleOCR `min_size`, ~3)
}

export const DEFAULT_DB_PARAMS: DBParams = {
  binarizeThreshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.5,
  maxCandidates: 1000,
  minBoxSize: 3,
};

/**
 * Emit prob-map distribution stats to the console while tuning detection.
 *
 * Defaults on (useful while calibrating detection), but the runner flips it off
 * in production via {@link setDbPostProcessDebug} so these stats don't reach a
 * prod console — the same `debug` option that gates the runner's `dbg()` calls.
 */
let DEBUG_DET_STATS = true;

/**
 * Toggle dbPostProcess diagnostic stats. Called by the runner's factory so the
 * consumer's single `debug` option controls every diagnostic in the pipeline.
 */
export function setDbPostProcessDebug(enabled: boolean): void {
  DEBUG_DET_STATS = enabled;
}

/**
 * Main DB post-processing function — faithful port of PaddleOCR `boxes_from_bitmap`.
 *
 * Handles two det output shapes:
 *   - [batch, 1, H, W]  → probability map only (typical inference export). Binarize
 *     with the fixed `binarizeThreshold` (~0.3).
 *   - [batch, 2, H, W]  → channel 0 probability, channel 1 adaptive threshold. Binarize
 *     with `prob > thresh` (DB's differentiable binarization).
 *
 * Coordinate scaling from the prob-map (feature) frame to the destination
 * (original-image) frame happens INSIDE this function via `ratioW`/`ratioH`, so the
 * runner no longer post-scales the returned boxes.
 *
 * @param detData - Flattened detection output (row-major [batch][channels][H][W])
 * @param shape - [batch, channels, height, width]
 * @param params - DB parameters
 * @param ratioW - scale factor from prob-map width to destination width (default 1)
 * @param ratioH - scale factor from prob-map height to destination height (default 1)
 * @returns Array of text boxes with polygon coordinates and scores, highest score first
 */
export function dbPostProcess(
  detData: Float32Array,
  shape: [number, number, number, number], // [batch, channels, height, width]
  params: DBParams = DEFAULT_DB_PARAMS,
  ratioW: number = 1,
  ratioH: number = 1
): TextBox[] {
  const [batch, channels, height, width] = shape;
  void batch; // batch is always 1 for single-image inference

  const pixelCount = width * height;
  const hasThresholdMap = channels >= 2;

  // Probability map is always channel 0.
  const prob = new Float32Array(pixelCount);
  const thresh = hasThresholdMap ? new Float32Array(pixelCount) : null;
  for (let i = 0; i < pixelCount; i++) {
    prob[i] = detData[i]!;
    if (thresh) thresh[i] = detData[pixelCount + i]!;
  }

  // Range check: PaddleOCR det exports are normally sigmoid'd to [0,1], but some
  // emit pre-sigmoid logits. If the range falls outside [0,1], squash to probabilities.
  let pmin = Infinity;
  let pmax = -Infinity;
  for (let i = 0; i < pixelCount; i++) {
    const v = prob[i]!;
    if (v < pmin) pmin = v;
    if (v > pmax) pmax = v;
  }
  if (pmax > 1.5 || pmin < -0.5) {
    for (let i = 0; i < pixelCount; i++) {
      prob[i] = 1 / (1 + Math.exp(-prob[i]!));
    }
    if (DEBUG_DET_STATS) console.log("[dbPostProcess] det output was logits -> applied sigmoid");
  }
  if (DEBUG_DET_STATS) logProbStats(prob, "det prob map");

  // Step 1: Binarize. Adaptive threshold map when available, else the fixed
  // binarizeThreshold (~0.3). The box-level 0.6 cutoff is far too aggressive for
  // per-pixel binarization and yields zero connected components.
  const binaryMap = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const cutoff = thresh ? thresh[i]! : params.binarizeThreshold;
    binaryMap[i] = prob[i]! > cutoff ? 1 : 0;
  }

  // Step 2: Find connected components (contours).
  const contours = findContours(binaryMap, width, height, params.binarizeThreshold, prob);

  // Destination (original-image) frame extents; boxes are scaled into this frame
  // at the end so callers receive coordinates in source-image space.
  const destW = Math.round(width * ratioW);
  const destH = Math.round(height * ratioH);

  // Step 3: boxes_from_bitmap — get_mini_boxes -> score -> unclip -> get_mini_boxes.
  const resultBoxes: TextBox[] = [];
  for (let ci = 0; ci < contours.length && resultBoxes.length < params.maxCandidates; ci++) {
    const contour = contours[ci]!;
    // Convert {x,y} contour points to [x,y] tuples for the geometry modules.
    const ptsIn = contour.map((p) => [p.x, p.y] as [number, number]);

    // First get_mini_boxes: smallest enclosing rect + short side.
    const { box: points, sside } = getMiniBoxes(ptsIn);
    if (sside < params.minBoxSize) continue;

    // Box-level confidence: masked mean of the prob map inside the quad.
    const score = boxScoreFast(prob, width, height, points);
    if (params.boxThreshold > score) continue;

    // Unclip (expand) the 4-point rectangle by the PaddleOCR unclip distance.
    const expanded = unclipBox(points, params.unclipRatio);

    // Second get_mini_boxes on the expanded polygon.
    const { box: box2, sside: sside2 } = getMiniBoxes(expanded);
    if (sside2 < params.minBoxSize + 2) continue;

    // Scale from prob-map (feature) coordinates to the destination frame, clamped
    // to the image bounds. This mirrors PaddleOCR's
    // box[:, 0] = clip(round(box[:, 0] / width * dest_width), 0, dest_width).
    const sb = box2.map(([x, y]) => [
      clamp(Math.round(x * ratioW), 0, destW),
      clamp(Math.round(y * ratioH), 0, destH),
    ]);

    resultBoxes.push({ points: sb, score });
  }

  // Sort by score descending and cap at max candidates.
  resultBoxes.sort((a, b) => b.score - a.score);
  return resultBoxes.slice(0, params.maxCandidates);
}

/**
 * Clamp `v` to the closed range [lo, hi].
 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Log the probability-map value distribution (for tuning detection).
 */
function logProbStats(prob: Float32Array, label: string): void {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let c3 = 0;
  let c5 = 0;
  for (let i = 0; i < prob.length; i++) {
    const v = prob[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v > 0.3) c3++;
    if (v > 0.5) c5++;
  }
  const n = prob.length;
  console.log(
    `[dbPostProcess] ${label}: min=${min.toFixed(3)} max=${max.toFixed(3)} ` +
    `mean=${(sum / n).toFixed(3)} pct>0.3=${(100 * c3 / n).toFixed(1)}% pct>0.5=${(100 * c5 / n).toFixed(1)}%`
  );
}

/**
 * Find connected components in binary map using BFS
 *
 * Returns contours where each contour is an array of points
 */
function findContours(
  binaryMap: Uint8Array,
  width: number,
  height: number,
  minScore: number,
  probMap: Float32Array
): Point[][] {
  const visited = new Uint8Array(width * height);
  const contours: Point[][] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binaryMap[idx] === 1 && visited[idx] === 0 && probMap[idx]! >= minScore) {
        const contour = bfsComponent(x, y, binaryMap, visited, width, height);
        if (convexHull(contour).length >= 4) {
          contours.push(convexHull(contour));
        }
      }
    }
  }

  return contours;
}

/**
 * BFS to find all pixels in a connected component
 */
function bfsComponent(
  startX: number,
  startY: number,
  binaryMap: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number
): Point[] {
  const component: Point[] = [];
  const queue: Point[] = [{ x: startX, y: startY }];

  visited[startY * width + startX] = 1;

  const dirs = [
    { x: 0, y: -1 }, // up
    { x: 1, y: 0 },  // right
    { x: 0, y: 1 },  // down
    { x: -1, y: 0 }, // left
  ];

  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    component.push({ x, y });

    for (const dir of dirs) {
      const nx = x + dir.x;
      const ny = y + dir.y;

      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const idx = ny * width + nx;
        if (binaryMap[idx] === 1 && visited[idx] === 0) {
          visited[idx] = 1;
          queue.push({ x: nx, y: ny });
        }
      }
    }
  }

  return component;
}

/**
 * Compute convex hull of a point set using Graham scan
 */
function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points;

  // Find point with lowest y (and leftmost if tie)
  let lowest = points[0]!;
  for (const p of points) {
    if (p.y < lowest.y || (p.y === lowest.y && p.x < lowest.x)) {
      lowest = p;
    }
  }

  // Sort points by polar angle with respect to lowest point
  const sorted = points
    .filter((p) => p !== lowest)
    .sort((a, b) => {
      const cross = crossProduct(lowest, a, b);
      if (cross === 0) {
        // Collinear — sort by distance
        const distA = distSq(lowest, a);
        const distB = distSq(lowest, b);
        return distA - distB;
      }
      return -cross; // Clockwise
    });

  const hull: Point[] = [lowest];

  for (const p of sorted) {
    while (hull.length > 1 && crossProduct(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0) {
      hull.pop();
    }
    hull.push(p);
  }

  return hull;
}

/**
 * 2D cross product of vectors OA and OB
 * Returns positive if O->A->B is clockwise, negative if counterclockwise, zero if collinear
 */
function crossProduct(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Squared distance between two points
 */
function distSq(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
