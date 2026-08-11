import { unclipBox } from "../polygon-offset";

/**
 * Tests for unclipBox — PaddleOCR `unclip` rectangle miter offset.
 *
 * Geometry is pure math; these run under jsdom with no DOM dependency.
 */
describe("unclipBox (PaddleOCR unclip, rectangle miter offset)", () => {
  it("unit square ratio 2.0 grows each side by 0.5 (distance = area*ratio/perim = 1*2/4)", () => {
    const box: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const out = unclipBox(box, 2.0);
    expect(out).toHaveLength(4);
    // Order-independent: the set of grown corners equals these 4 (within 1e-6).
    const expected: Array<[number, number]> = [
      [-0.5, -0.5],
      [1.5, -0.5],
      [1.5, 1.5],
      [-0.5, 1.5],
    ];
    for (const e of expected) {
      const matched = out.some(
        (o) => Math.abs(o[0] - e[0]) < 1e-6 && Math.abs(o[1] - e[1]) < 1e-6
      );
      expect(matched).toBe(true);
    }
  });

  it("2x1 rectangle ratio 1.5 grows by 0.5 each side -> recovered width 3, height 2", () => {
    const box: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ];
    const out = unclipBox(box, 1.5);
    expect(out).toHaveLength(4);
    // area=2, perimeter=6, distance = 2*1.5/6 = 0.5
    const expected: Array<[number, number]> = [
      [-0.5, -0.5],
      [2.5, -0.5],
      [2.5, 1.5],
      [-0.5, 1.5],
    ];
    const xs = out.map((p) => p[0]).sort((a, b) => a - b);
    const ys = out.map((p) => p[1]).sort((a, b) => a - b);
    const width = xs[xs.length - 1] - xs[0];
    const height = ys[ys.length - 1] - ys[0];
    expect(width).toBeCloseTo(3, 6);
    expect(height).toBeCloseTo(2, 6);
    for (const e of expected) {
      const matched = out.some(
        (o) => Math.abs(o[0] - e[0]) < 1e-6 && Math.abs(o[1] - e[1]) < 1e-6
      );
      expect(matched).toBe(true);
    }
  });

  it("uses the PaddleOCR distance formula for a known box (3x2, ratio 1.0 -> distance 0.6)", () => {
    // area = 6, perimeter = 10, distance = 6 * 1.0 / 10 = 0.6
    // grown width = 3 + 2*0.6 = 4.2, height = 2 + 2*0.6 = 3.2
    const box: Array<[number, number]> = [
      [0, 0],
      [3, 0],
      [3, 2],
      [0, 2],
    ];
    const out = unclipBox(box, 1.0);
    const xs = out.map((p) => p[0]).sort((a, b) => a - b);
    const ys = out.map((p) => p[1]).sort((a, b) => a - b);
    const width = xs[xs.length - 1] - xs[0];
    const height = ys[ys.length - 1] - ys[0];
    expect(width).toBeCloseTo(4.2, 6);
    expect(height).toBeCloseTo(3.2, 6);
  });

  it("preserves input vertex order (out[i] corresponds to box[i])", () => {
    const box: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const out = unclipBox(box, 2.0);
    // box[0]=(0,0) -> (-0.5,-0.5); box[1]=(1,0)->(1.5,-0.5); box[2]->(1.5,1.5); box[3]->(-0.5,1.5)
    expect(out[0][0]).toBeCloseTo(-0.5, 6);
    expect(out[0][1]).toBeCloseTo(-0.5, 6);
    expect(out[1][0]).toBeCloseTo(1.5, 6);
    expect(out[1][1]).toBeCloseTo(-0.5, 6);
    expect(out[2][0]).toBeCloseTo(1.5, 6);
    expect(out[2][1]).toBeCloseTo(1.5, 6);
    expect(out[3][0]).toBeCloseTo(-0.5, 6);
    expect(out[3][1]).toBeCloseTo(1.5, 6);
  });

  it("handles a degenerate zero-perimeter box by copying it through", () => {
    const box: Array<[number, number]> = [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ];
    const out = unclipBox(box, 1.5);
    expect(out).toHaveLength(4);
    for (const p of out) {
      expect(p[0]).toBe(1);
      expect(p[1]).toBe(1);
    }
  });

  it("does not mutate the input box", () => {
    const box: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ];
    const snapshot = box.map((p) => [p[0], p[1]] as [number, number]);
    unclipBox(box, 1.5);
    expect(box).toEqual(snapshot);
  });
});
