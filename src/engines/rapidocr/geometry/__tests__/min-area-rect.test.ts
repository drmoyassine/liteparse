/**
 * Unit tests for src/workers/geometry/min-area-rect.ts
 *
 * Pure-math tests — run under jest/jsdom with no DOM or onnxruntime deps.
 * Cases:
 *   1. Axis-aligned square: known width/height/area + explicit corner ORDER
 *      for getMiniBoxes (the load-bearing part).
 *   2. 40x20 rectangle rotated 30deg about (50,50): area ~= 800, sside ~= 20.
 *   3. Degenerate single point: width=0, height=0.
 */

import { describe, expect, test } from "vitest";
import { minAreaRect, getMiniBoxes } from "../min-area-rect";

describe("minAreaRect", () => {
  test("axis-aligned 10x10 square -> width=10, height=10, area=100", () => {
    const sq: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const { width, height, corners } = minAreaRect(sq);
    expect(width).toBeCloseTo(10, 10);
    expect(height).toBeCloseTo(10, 10);
    expect(width * height).toBeCloseTo(100, 10);
    expect(corners).toHaveLength(4);
  });

  test("40x20 rect rotated 30deg about (50,50) -> area ~= 800", () => {
    // 4 corners of a 40-wide x 20-tall rectangle, rotated 30deg CCW about its
    // center (50,50). Offsets (±20,±10) rotated by theta=30deg then translated.
    //   cos30 = 0.8660254037844387, sin30 = 0.5
    const rot: Array<[number, number]> = [
      [37.67949192431124, 31.339745962155614], // (-20,-10)
      [72.32050807568876, 51.339745962155614], // ( 20,-10)
      [62.32050807568877, 68.660254037844386], // ( 20, 10)
      [27.67949192431123, 48.660254037844386], // (-20, 10)
    ];
    const { width, height } = minAreaRect(rot);
    // The two extents are 40 and 20 (in some order); product is the area.
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    expect(longSide).toBeCloseTo(40, 6);
    expect(shortSide).toBeCloseTo(20, 6);
    expect(width * height).toBeCloseTo(800, 6);
  });

  test("degenerate single point -> width=0, height=0", () => {
    const { width, height, corners } = minAreaRect([[5, 7]]);
    expect(width).toBe(0);
    expect(height).toBe(0);
    expect(corners).toHaveLength(4);
    // All four corners collapse to the input point.
    for (const c of corners) {
      expect(c[0]).toBe(5);
      expect(c[1]).toBe(7);
    }
  });

  test("empty input -> width=0, height=0, 4 corners", () => {
    const { width, height, corners } = minAreaRect([]);
    expect(width).toBe(0);
    expect(height).toBe(0);
    expect(corners).toHaveLength(4);
  });
});

describe("getMiniBoxes", () => {
  test("axis-aligned square -> sside=10, box ordered [TL,TR,BR,BL]", () => {
    const sq: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const { box, sside } = getMiniBoxes(sq);

    // Short side of the enclosing rect is 10.
    expect(sside).toBeCloseTo(10, 10);

    // Corner ORDER is the load-bearing part: [TL, TR, BR, BL] in image coords
    // (y-down): TL=(0,0), TR=(10,0), BR=(10,10), BL=(0,10).
    expect(box).toHaveLength(4);
    expect(box[0]![0]).toBeCloseTo(0, 9);
    expect(box[0]![1]).toBeCloseTo(0, 9);
    expect(box[1]![0]).toBeCloseTo(10, 9);
    expect(box[1]![1]).toBeCloseTo(0, 9);
    expect(box[2]![0]).toBeCloseTo(10, 9);
    expect(box[2]![1]).toBeCloseTo(10, 9);
    expect(box[3]![0]).toBeCloseTo(0, 9);
    expect(box[3]![1]).toBeCloseTo(10, 9);

    // Explicit array form for clarity.
    expect(box).toEqual([
      [0, 0], // TL
      [10, 0], // TR
      [10, 10], // BR
      [0, 10], // BL
    ]);
  });

  test("40x20 rect rotated 30deg -> sside ~= 20", () => {
    const rot: Array<[number, number]> = [
      [37.67949192431124, 31.339745962155614],
      [72.32050807568876, 51.339745962155614],
      [62.32050807568877, 68.660254037844386],
      [27.67949192431123, 48.660254037844386],
    ];
    const { sside } = getMiniBoxes(rot);
    expect(sside).toBeCloseTo(20, 6);
  });
});
