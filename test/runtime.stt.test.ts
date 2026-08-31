import { afterEach, describe, expect, it } from "vitest";
import { getBrowserSttEngine, resolveStt, setBrowserSttEngine } from "../src/runtime.js";
import type { SttEngine } from "../src/types.js";

/**
 * The browser STT registry — the audio counterpart of the OCR registry tests
 * (rapidocr.test.ts). A consumer registers a local Moonshine engine once at
 * app start; parseDocument then routes audio through it before the external
 * gateway. Explicit injection still wins, and absence is `null` (never a
 * `none` placeholder — the route just omits the local leg).
 */

function fakeSttEngine(name: string): SttEngine {
  return { name, available: true, transcribe: async () => ({ text: "" }) };
}

afterEach(() => {
  setBrowserSttEngine(null);
});

describe("setBrowserSttEngine / getBrowserSttEngine", () => {
  it("starts null — audio routes external-only until a consumer registers", () => {
    expect(getBrowserSttEngine()).toBeNull();
  });

  it("round-trips the registered engine", () => {
    const engine = fakeSttEngine("moonshine");
    setBrowserSttEngine(engine);
    expect(getBrowserSttEngine()).toBe(engine);
  });

  it("unregisters on null (app teardown / hot reload)", () => {
    setBrowserSttEngine(fakeSttEngine("moonshine"));
    setBrowserSttEngine(null);
    expect(getBrowserSttEngine()).toBeNull();
  });
});

describe("resolveStt", () => {
  it("returns null when neither injection nor registration is present", () => {
    expect(resolveStt({})).toBeNull();
  });

  it("prefers an injected ParseOptions.sttEngine over the registered engine", () => {
    const injected = fakeSttEngine("injected");
    const registered = fakeSttEngine("registered");
    setBrowserSttEngine(registered);
    expect(resolveStt({ sttEngine: injected })).toBe(injected);
  });

  it("falls back to the registered engine when nothing is injected", () => {
    const registered = fakeSttEngine("registered");
    setBrowserSttEngine(registered);
    expect(resolveStt({})).toBe(registered);
  });
});
