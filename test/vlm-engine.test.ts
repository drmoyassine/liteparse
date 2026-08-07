import { describe, expect, it, vi } from "vitest";
import { createVlmOcrEngine } from "../src/ocr/vlm.js";
import type { VlmGateway } from "../src/types.js";

describe("createVlmOcrEngine", () => {
  it("delegates recognition to the wrapped gateway and trims output", async () => {
    const readImage = vi.fn(async () => "  transcribed text  ");
    const vlm: VlmGateway = { readImage };
    const engine = createVlmOcrEngine(vlm);

    const img = new Uint8Array([1, 2, 3]);
    const result = await engine.recognize(img, { pageIndex: 2, totalPages: 5, hint: "passport" });

    expect(result.text).toBe("transcribed text");
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(readImage).toHaveBeenCalledWith(img, {
      pageIndex: 2,
      totalPages: 5,
      hint: "passport",
      signal: undefined,
      mime: "image/png",
    });
  });

  it("is available and named 'vlm'", () => {
    const engine = createVlmOcrEngine({ readImage: async () => "" });
    expect(engine.available).toBe(true);
    expect(engine.name).toBe("vlm");
  });

  it("returns empty string (not a throw) when the gateway returns nothing", async () => {
    const engine = createVlmOcrEngine({ readImage: async () => "" });
    const result = await engine.recognize(new Uint8Array(0), { pageIndex: 0, totalPages: 1 });
    expect(result.text).toBe("");
  });

  it("honours a custom default mime type", async () => {
    const readImage = vi.fn(async () => "x");
    const engine = createVlmOcrEngine({ readImage }, "image/jpeg");
    await engine.recognize(new Uint8Array(0), { pageIndex: 0, totalPages: 1 });
    expect(readImage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ mime: "image/jpeg" }),
    );
  });
});
