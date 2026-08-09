/**
 * Tests for `detectCapabilities` — synchronous, headless-safe runtime detection.
 *
 * The vitest default environment is `node`, so `navigator`/`window` are absent
 * unless a test stubs them. We stub them on `globalThis` (which is exactly where
 * the source reads them) and restore originals in `afterEach` so test ordering
 * does not matter. `detectCapabilities` must run fully headless (no GPU ⇒
 * `hasWebGPU` false, no throw) and let overrides win over detected values.
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/router/capabilities.js";

const g = globalThis as Record<PropertyKey, unknown>;
const originalWindow = g.window;
const originalNavigator = g.navigator;
const originalDeno = g.Deno;

afterEach(() => {
  // Restore globals between tests so ordering is irrelevant.
  if (originalWindow === undefined) delete g.window;
  else g.window = originalWindow;
  if (originalNavigator === undefined) delete g.navigator;
  else g.navigator = originalNavigator;
  if (originalDeno === undefined) delete g.Deno;
  else g.Deno = originalDeno;
});

/** Make this test look like a browser: both `window` and `navigator` present. */
function setBrowserNavigator(nav: Record<string, unknown>): void {
  g.window = {};
  g.navigator = nav;
}

describe("detectCapabilities — runtime", () => {
  it("reports node with no WebGPU when navigator is absent (headless)", () => {
    delete g.window;
    delete g.navigator;
    const caps = detectCapabilities();
    expect(caps.runtime).toBe("node");
    expect(caps.hasWebGPU).toBe(false);
    expect(caps.metered).toBe(false);
    expect(caps.storagePersisted).toBe(false);
    expect(caps.availableScripts).toEqual(["latin"]);
  });

  it("detects a browser when both window and navigator are present", () => {
    setBrowserNavigator({});
    const caps = detectCapabilities();
    expect(caps.runtime).toBe("browser");
  });

  it("detects deno when the Deno global is present", () => {
    delete g.window;
    delete g.navigator;
    g.Deno = { version: "1.40" };
    const caps = detectCapabilities();
    expect(caps.runtime).toBe("deno");
    expect(caps.hasWebGPU).toBe(false);
    expect(caps.availableScripts).toEqual(["latin"]);
  });

  it("stays headless-safe and never throws with no globals at all", () => {
    delete g.window;
    delete g.navigator;
    delete g.Deno;
    expect(() => detectCapabilities()).not.toThrow();
  });
});

describe("detectCapabilities — WebGPU", () => {
  it("detects WebGPU when navigator.gpu is present", () => {
    setBrowserNavigator({ gpu: {} });
    const caps = detectCapabilities();
    expect(caps.runtime).toBe("browser");
    expect(caps.hasWebGPU).toBe(true);
  });

  it("reports no WebGPU when navigator has no gpu property", () => {
    setBrowserNavigator({});
    const caps = detectCapabilities();
    expect(caps.runtime).toBe("browser");
    expect(caps.hasWebGPU).toBe(false);
  });

  it("treats a falsy gpu (present but null) as no WebGPU", () => {
    setBrowserNavigator({ gpu: null });
    const caps = detectCapabilities();
    expect(caps.hasWebGPU).toBe(false);
  });

  it("does not report WebGPU in a non-browser runtime even if gpu were present", () => {
    // Force node: detection is gated on runtime === "browser".
    delete g.window;
    delete g.navigator;
    const caps = detectCapabilities({ runtime: "node" });
    expect(caps.hasWebGPU).toBe(false);
  });
});

describe("detectCapabilities — metered connection", () => {
  it("flags metered via connection.saveData === true", () => {
    setBrowserNavigator({ connection: { saveData: true } });
    expect(detectCapabilities().metered).toBe(true);
  });

  it("flags metered via effectiveType '2g'", () => {
    setBrowserNavigator({ connection: { effectiveType: "2g" } });
    expect(detectCapabilities().metered).toBe(true);
  });

  it("flags metered via effectiveType 'slow-2g'", () => {
    setBrowserNavigator({ connection: { effectiveType: "slow-2g" } });
    expect(detectCapabilities().metered).toBe(true);
  });

  it("does not flag a fast unmetered connection", () => {
    setBrowserNavigator({ connection: { effectiveType: "4g", saveData: false } });
    expect(detectCapabilities().metered).toBe(false);
  });

  it("does not flag metered when no connection object is present", () => {
    setBrowserNavigator({});
    expect(detectCapabilities().metered).toBe(false);
  });
});

describe("detectCapabilities — overrides win", () => {
  it("an explicit hasWebGPU:false override beats a detected gpu", () => {
    setBrowserNavigator({ gpu: {} }); // detected would be true
    const caps = detectCapabilities({ hasWebGPU: false });
    expect(caps.hasWebGPU).toBe(false);
  });

  it("an explicit metered:false override beats a detected saveData", () => {
    setBrowserNavigator({ connection: { saveData: true } }); // detected true
    const caps = detectCapabilities({ metered: false });
    expect(caps.metered).toBe(false);
  });

  it("overrides every field, forcing node + WebGPU + custom scripts", () => {
    setBrowserNavigator({ connection: { saveData: true } });
    const caps = detectCapabilities({
      runtime: "node",
      hasWebGPU: true,
      metered: false,
      availableScripts: ["latin", "cjk"],
      storagePersisted: true,
    });
    expect(caps.runtime).toBe("node");
    expect(caps.hasWebGPU).toBe(true); // forced true even under a node runtime
    expect(caps.metered).toBe(false);
    expect(caps.availableScripts).toEqual(["latin", "cjk"]);
    expect(caps.storagePersisted).toBe(true);
  });

  it("honours an empty availableScripts override", () => {
    const caps = detectCapabilities({ availableScripts: [] });
    expect(caps.availableScripts).toEqual([]);
  });
});
