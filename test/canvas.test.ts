import { describe, expect, it } from "vitest";
import { canvasRaster, grayscalePixels, normalizePixels } from "../src/raster/canvas.js";

function rgba(...quads: Array<[number, number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(quads.length * 4);
  quads.forEach(([r, g, b, a], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  });
  return out;
}

describe("grayscalePixels", () => {
  it("maps RGB to luminance, preserves alpha", () => {
    const d = rgba([10, 20, 30, 255], [100, 100, 100, 255]);
    grayscalePixels(d);
    // 0.299*10 + 0.587*20 + 0.114*30 = 18.15 → 18
    expect(Array.from(d.slice(0, 4))).toEqual([18, 18, 18, 255]);
    expect(Array.from(d.slice(4, 8))).toEqual([100, 100, 100, 255]);
  });
});

describe("normalizePixels", () => {
  it("contrast-stretches channels to span 0–255", () => {
    const d = rgba([18, 18, 18, 255], [100, 100, 100, 255]);
    normalizePixels(d);
    // min=18, max=100 → 18 maps to 0, 100 maps to 255
    expect(Array.from(d.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(d.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });

  it("is a no-op when all pixels are identical", () => {
    const d = rgba([50, 50, 50, 255]);
    normalizePixels(d); // range = max(1, 0) → no division by zero
    expect(Array.from(d.slice(0, 4))).toEqual([50, 50, 50, 255]);
  });
});

describe("canvasRaster adapter", () => {
  it("reports its identity as the browser canvas adapter", () => {
    expect(canvasRaster.name).toBe("canvas");
    expect(canvasRaster.runtime).toBe("browser");
  });

  it("reports unavailable in the node test environment (no Canvas/DOM)", () => {
    // No OffscreenCanvas and no document in vitest's node env → not available.
    expect(canvasRaster.available).toBe(false);
  });
});
