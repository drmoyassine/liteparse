import { describe, expect, it, vi } from "vitest";

/**
 * The natives (sharp / @napi-rs/canvas) are installed as ROOT devDeps — the
 * server adapters (this module + rapidocr-server) need them for local dev and
 * the runner's tests. Consumers without them must get a clean rejection, so
 * absence is SIMULATED by making the dynamic import throw, hermetically.
 */
describe("createSharpRaster (opt-in Node adapter)", () => {
  it("rejects when the native deps (sharp / @napi-rs/canvas) are not installed", async () => {
    vi.resetModules();
    vi.doMock("sharp", () => {
      throw new Error("Cannot find module 'sharp'");
    });
    const mod = await import("../src/raster/sharp.js");
    await expect(mod.createSharpRaster()).rejects.toThrow();
  });

  it("initializes when the natives are present (devDeps on this machine)", async () => {
    // Also proves pdf.js + @napi-rs/canvas load under Node — the runner's
    // rasterization path (see apps/runner/test/ocr-pipeline.test.ts for E2E).
    vi.resetModules();
    vi.doUnmock("sharp");
    const { createSharpRaster } = await import("../src/raster/sharp.js");
    const raster = await createSharpRaster();
    expect(raster.name).toBe("sharp");
    expect(raster.runtime).toBe("node");
  });
});
