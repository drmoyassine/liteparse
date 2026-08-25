import { describe, expect, it } from "vitest";
import { boxScoreFast } from "../polygon-fill";

describe("boxScoreFast", () => {
  it("returns the full-map mean for a quad covering the entire prob map", () => {
    const probW = 5;
    const probH = 5;
    const prob = new Float32Array(probW * probH).fill(1.0);
    const box: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    expect(boxScoreFast(prob, probW, probH, box)).toBe(1.0);
  });

  it("computes the masked mean over a column-gradient sub-quad", () => {
    // prob[r*5+c] = c (column index). Sub-quad covers cols 1..3, all rows.
    const probW = 5;
    const probH = 5;
    const prob = new Float32Array(probW * probH);
    for (let r = 0; r < probH; r++) {
      for (let c = 0; c < probW; c++) {
        prob[r * probW + c] = c;
      }
    }
    const box: Array<[number, number]> = [
      [1, 0],
      [3, 0],
      [3, 4],
      [1, 4],
    ];
    // Cols 1,2,3 → values 1,2,3 → mean (1+2+3)/3 = 2.0
    expect(boxScoreFast(prob, probW, probH, box)).toBe(2.0);
  });

  it("counts only quad-masked pixels when the AABB is larger than the quad", () => {
    // prob[r*5+c] = r (row index). Parallelogram quad: [(0,0),(2,0),(4,4),(2,4)].
    // AABB = full 5x5 map but the mask covers a diagonal band, not the full box.
    const probW = 5;
    const probH = 5;
    const prob = new Float32Array(probW * probH);
    for (let r = 0; r < probH; r++) {
      for (let c = 0; c < probW; c++) {
        prob[r * probW + c] = r;
      }
    }
    const box: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [4, 4],
      [2, 4],
    ];
    // Hand-traced scanline fill:
    //   row 0 (y=0.5): cols 1,2 → values 0,0
    //   row 1 (y=1.5): cols 1,2 → values 1,1
    //   row 2 (y=2.5): cols 2,3 → values 2,2
    //   row 3 (y=3.5): cols 2,3 → values 3,3
    //   row 4 (y=4.5): no crossings → empty
    // sum = 0+2+4+6 = 12, count = 8, mean = 1.5
    const result = boxScoreFast(prob, probW, probH, box);
    expect(result).toBe(1.5);
    // Sanity: the AABB mean would be 2.0, proving the mask actually restricts.
    expect(result).not.toBe(2.0);
  });

  it("clamps out-of-bounds box corners without producing NaN", () => {
    const probW = 5;
    const probH = 5;
    const prob = new Float32Array(probW * probH).fill(1.0);
    const box: Array<[number, number]> = [
      [-5, -5],
      [9, -5],
      [9, 9],
      [-5, 9],
    ];
    const result = boxScoreFast(prob, probW, probH, box);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(1.0);
  });

  it("returns 0 when the box is entirely outside the prob map (empty clamped AABB)", () => {
    const probW = 5;
    const probH = 5;
    const prob = new Float32Array(probW * probH).fill(1.0);
    // Box entirely to the left of the map: maxX=-1 → xmax=min(4,-1)=-1 < xmin=0.
    const box: Array<[number, number]> = [
      [-5, 0],
      [-1, 0],
      [-1, 4],
      [-5, 4],
    ];
    expect(boxScoreFast(prob, probW, probH, box)).toBe(0);
  });
});
