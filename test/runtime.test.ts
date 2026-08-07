import { afterEach, describe, expect, it } from "vitest";
import { resolveOcr, resolveRaster, runtimeInfo } from "../src/runtime.js";

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;
const originalProcess = (globalThis as { process?: unknown }).process;

afterEach(() => {
  // Restore globals between tests.
  const g = globalThis as { window?: unknown; document?: unknown; process?: unknown };
  if (originalWindow === undefined) delete g.window;
  else g.window = originalWindow;
  if (originalDocument === undefined) delete g.document;
  else g.document = originalDocument;
  if (originalProcess === undefined) delete g.process;
  else g.process = originalProcess;
});

describe("runtime detection", () => {
  it("reports the vitest node environment as node, not browser", () => {
    expect(runtimeInfo.isNode()).toBe(true);
    expect(runtimeInfo.isBrowser()).toBe(false);
  });

  it("detects a browser-shaped global as browser", () => {
    const g = globalThis as { window?: unknown; document?: unknown; process?: unknown };
    g.window = {} as object;
    g.document = {} as object;
    delete g.process;
    expect(runtimeInfo.isBrowser()).toBe(true);
    expect(runtimeInfo.isNode()).toBe(false);
  });

  it("reports neither when both window and process are absent", () => {
    const g = globalThis as { window?: unknown; document?: unknown; process?: unknown };
    delete g.window;
    delete g.document;
    delete g.process;
    expect(runtimeInfo.isBrowser()).toBe(false);
    expect(runtimeInfo.isNode()).toBe(false);
  });
});

describe("adapter resolution (step 1: always none)", () => {
  it("resolves to the none raster when nothing is injected", async () => {
    const r = await resolveRaster({});
    expect(r.available).toBe(false);
    expect(r.runtime).toBe("none");
  });

  it("resolves to the none OCR engine under auto", async () => {
    const o = await resolveOcr({ ocr: "auto" });
    expect(o.available).toBe(false);
  });

  it("resolves to the none OCR engine when ocr is off", async () => {
    const o = await resolveOcr({ ocr: "off" });
    expect(o.available).toBe(false);
  });

  it("returns an injected adapter as-is", async () => {
    const injected = {
      name: "custom",
      runtime: "node" as const,
      available: true,
      rasterizePdfPage: async () => new Uint8Array(),
    };
    const r = await resolveRaster({ raster: injected });
    expect(r).toBe(injected);
  });
});
