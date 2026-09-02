import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ParseService } from "../src/service.js";
import type { SttService } from "../src/stt-service.js";

/**
 * /docs + /openapi.json — unauthenticated like /health, spec version wired to
 * the runner VERSION, and every documented path/response present so the spec
 * can't silently drift behind a handler change.
 */

function buildApp() {
  return createApp({
    apiKey: "k",
    version: "0.0.0-test",
    service: vi.fn() as unknown as ParseService,
    sttService: vi.fn() as unknown as SttService,
    ocrReady: () => true,
    sttReady: () => true,
  });
}

describe("GET /openapi.json", () => {
  it("is unauthenticated and carries the wiring version", async () => {
    const res = await buildApp().request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("0.0.0-test");
    for (const path of ["/health", "/parse", "/transcribe"]) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });

  it("documents the documented status codes (drift guard against handler edits)", async () => {
    const doc = (await (await buildApp().request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(doc.paths["/parse"]!.post!.responses).sort()).toEqual(
      ["200", "400", "401", "405", "413", "500", "503"].sort(),
    );
    expect(Object.keys(doc.paths["/transcribe"]!.post!.responses).sort()).toEqual(
      ["200", "400", "401", "405", "413", "422", "500", "503"].sort(),
    );
  });

  it("documents the API-key header and never embeds a key value", async () => {
    const raw = await (await buildApp().request("/openapi.json")).text();
    const doc = JSON.parse(raw) as {
      components: { securitySchemes: Record<string, { name: string }> };
    };
    expect(doc.components.securitySchemes["ApiKeyAuth"]!.name).toBe("X-API-Key");
    expect(raw).not.toContain("PARSE_RUNNER_API_KEY=");
  });
});

describe("GET /docs", () => {
  it("serves the Swagger UI page unauthenticated, pointed at our spec", async () => {
    const res = await buildApp().request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/openapi.json");
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
