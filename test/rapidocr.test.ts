import { afterEach, describe, expect, it } from "vitest";
import { createRapidOcrEngine } from "../src/ocr/rapidocr.js";
import { getBrowserOcrEngine, resolveOcr, setBrowserOcrEngine } from "../src/runtime.js";

afterEach(() => {
  setBrowserOcrEngine(null);
  const g = globalThis as { window?: unknown; document?: unknown };
  delete g.window;
  delete g.document;
});

describe("createRapidOcrEngine", () => {
  it("delegates to the runner, trimming text and passing confidence through", async () => {
    const engine = createRapidOcrEngine({
      runner: { recognize: async () => ({ text: " hi ", confidence: 0.9 }) },
    });
    const result = await engine.recognize(new Uint8Array(0), { pageIndex: 0, totalPages: 1 });
    expect(result.text).toBe("hi");
    expect(result.confidence).toBe(0.9);
    expect(engine.name).toBe("rapidocr");
    expect(engine.available).toBe(true);
  });

  it("returns empty (not a throw) when the runner yields nothing", async () => {
    const engine = createRapidOcrEngine({ runner: { recognize: async () => ({ text: "" }) } });
    const result = await engine.recognize(new Uint8Array(0), { pageIndex: 0, totalPages: 1 });
    expect(result.text).toBe("");
  });
});

describe("browser OCR registry", () => {
  it("round-trips through set/get and starts null", () => {
    expect(getBrowserOcrEngine()).toBeNull();
    const engine = createRapidOcrEngine({ runner: { recognize: async () => ({ text: "" }) } });
    setBrowserOcrEngine(engine);
    expect(getBrowserOcrEngine()).toBe(engine);
    setBrowserOcrEngine(null);
    expect(getBrowserOcrEngine()).toBeNull();
  });

  it("resolveOcr returns the registered engine in a browser environment", async () => {
    const g = globalThis as { window?: unknown; document?: unknown };
    g.window = {};
    g.document = {};
    const engine = createRapidOcrEngine({ runner: { recognize: async () => ({ text: "" }) } });
    setBrowserOcrEngine(engine);
    await expect(resolveOcr({ ocr: "auto" })).resolves.toBe(engine);
  });

  it("resolveOcr still returns none in the browser when nothing is registered", async () => {
    const g = globalThis as { window?: unknown; document?: unknown };
    g.window = {};
    g.document = {};
    const engine = await resolveOcr({ ocr: "auto" });
    expect(engine.available).toBe(false);
  });
});
