import { describe, expect, it } from "vitest";
import { createSharpRaster } from "../src/raster/sharp.js";

describe("createSharpRaster (opt-in Node adapter)", () => {
  it("rejects when the native deps (sharp / @napi-rs/canvas) are not installed", async () => {
    // In this dev environment neither package is installed, so the factory's
    // dynamic imports must reject rather than crash the import graph.
    await expect(createSharpRaster()).rejects.toThrow();
  });
});
