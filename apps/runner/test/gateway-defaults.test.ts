import { describe, expect, it } from "vitest";
import {
  defaultSttFromEnv,
  defaultVlmFromEnv,
  withDefaultStt,
  withDefaultVlm,
} from "../src/gateway-defaults.js";

const VLM_ENV = {
  VLM_GATEWAY_ENDPOINT: "https://gw.example/v1/audio/transcriptions",
  VLM_GATEWAY_API_KEY: "sk-vlm",
  VLM_GATEWAY_MODEL: "gpt-4o-mini",
};
const STT_ENV = {
  STT_GATEWAY_ENDPOINT: "https://gw.example/v1/audio/transcriptions",
  STT_GATEWAY_API_KEY: "sk-stt",
  STT_GATEWAY_MODEL: "gpt-4o-transcribe",
  STT_GATEWAY_KEY_HEADER: "x-custom-key",
};

describe("env parsing (all-or-nothing)", () => {
  it("builds a full gateway config when all required vars are present", () => {
    const g = defaultVlmFromEnv(VLM_ENV);
    expect(g).toEqual({
      endpoint: VLM_ENV.VLM_GATEWAY_ENDPOINT,
      apiKey: "sk-vlm",
      model: "gpt-4o-mini",
    });
  });

  it("honors an optional custom key header", () => {
    const g = defaultSttFromEnv(STT_ENV);
    expect(g?.keyHeader).toBe("x-custom-key");
  });

  it("returns undefined when any required var is missing", () => {
    expect(defaultVlmFromEnv({ VLM_GATEWAY_ENDPOINT: "https://x", VLM_GATEWAY_API_KEY: "k" })).toBeUndefined();
    expect(defaultSttFromEnv({ STT_GATEWAY_ENDPOINT: "https://x", STT_GATEWAY_MODEL: "m" })).toBeUndefined();
    expect(defaultSttFromEnv({})).toBeUndefined();
  });

  it("ignores blank values", () => {
    expect(defaultVlmFromEnv({ ...VLM_ENV, VLM_GATEWAY_API_KEY: "  " })).toBeUndefined();
  });
});

describe("caller-override precedence", () => {
  it("caller vlm wins; env default is not merged over it", () => {
    const caller = { vlm: { endpoint: "https://caller", apiKey: "k", model: "m" } };
    expect(withDefaultVlm(caller, defaultVlmFromEnv(VLM_ENV))).toBe(caller);
  });

  it("env default fills the gap when the caller passed none", () => {
    const out = withDefaultVlm({ maxPages: 3 }, defaultVlmFromEnv(VLM_ENV));
    expect(out.maxPages).toBe(3);
    expect(out.vlm?.apiKey).toBe("sk-vlm");
  });

  it("no caller options + no env default → unchanged empty options", () => {
    expect(withDefaultVlm(undefined, undefined)).toEqual({});
  });

  it("caller stt wins; env default fills the gap otherwise", () => {
    const caller = { stt: { endpoint: "https://caller", apiKey: "k", model: "m" } };
    expect(withDefaultStt(caller, defaultSttFromEnv(STT_ENV))).toBe(caller);
    const out = withDefaultStt({ language: "ar" }, defaultSttFromEnv(STT_ENV));
    expect(out.language).toBe("ar");
    expect(out.stt?.apiKey).toBe("sk-stt");
  });
});
