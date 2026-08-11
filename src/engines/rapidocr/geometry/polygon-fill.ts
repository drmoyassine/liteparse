/**
 * Polygon fill utilities for DB (Differentiable Binarization) post-processing.
 *
 * Pure geometry — no DOM, no worker globals, no onnxruntime imports. Runs under
 * jest/jsdom as well as in a Web Worker.
 *
 * Reference: PaddleOCR release/2.7 `ppocr/postprocess/db_postprocess.py`,
 * `box_score_fast` (cv2.fillPoly + cv2.mean(bitmap_crop, mask)[0]).
 */

/**
 * Compute the masked mean of a probability map inside a quadrilateral.
 *
 * Mirrors PaddleOCR `box_score_fast`: rasterize the quad into a binary mask via
 * scanline polygon fill, then return the mean of `prob` at masked pixels. This is
 * the detection-confidence score used to keep or discard a candidate text box.
 *
 * @param prob - Flattened probability map, row-major [probH][probW].
 * @param probW - Probability-map width.
 * @param probH - Probability-map height.
 * @param box - 4 corner points in prob-map (feature) coordinates [[x,y], ...].
 * @returns Mean prob over masked pixels, or 0 if the mask is empty.
 */
export function boxScoreFast(
  prob: Float32Array,
  probW: number,
  probH: number,
  box: ReadonlyArray<readonly [number, number]>
): number {
  // Axis-aligned bounding box of the quad, clamped to the prob map.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of box) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const xmin = Math.max(0, Math.floor(minX));
  const xmax = Math.min(probW - 1, Math.ceil(maxX));
  const ymin = Math.max(0, Math.floor(minY));
  const ymax = Math.min(probH - 1, Math.ceil(maxY));
  if (xmax < xmin || ymax < ymin) return 0;

  const w = xmax - xmin + 1;
  const h = ymax - ymin + 1;

  // Shift the quad into local AABB coordinates.
  const local = box.map(([x, y]) => [x - xmin, y - ymin] as [number, number]);

  // Scanline polygon fill: for each row, find edge crossings at the row-center
  // sample (ry + 0.5) and fill spans between consecutive crossing pairs.
  const mask = new Uint8Array(w * h);
  const n = local.length;
  for (let ry = 0; ry < h; ry++) {
    const y = ry + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = local[i];
      const b = local[(i + 1) % n];
      const ay = a[1];
      const by = b[1];
      // Half-open upward-crossing edge rule.
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const t = (y - ay) / (by - ay);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil(xs[k]);
      let c1 = Math.floor(xs[k + 1]);
      if (c0 < 0) c0 = 0;
      if (c1 > w - 1) c1 = w - 1;
      for (let col = c0; col <= c1; col++) {
        mask[ry * w + col] = 1;
      }
    }
  }

  // Masked mean of the probability map.
  let sum = 0;
  let count = 0;
  for (let ry = 0; ry < h; ry++) {
    const baseRow = (ymin + ry) * probW + xmin;
    const maskRow = ry * w;
    for (let rx = 0; rx < w; rx++) {
      if (mask[maskRow + rx] > 0) {
        sum += prob[baseRow + rx];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}
