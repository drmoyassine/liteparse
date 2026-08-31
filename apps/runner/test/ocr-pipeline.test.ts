import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLiteparseService } from "../src/service.js";

/**
 * The REAL end-to-end parity proof: a scanned PDF (JPEG-only page, no text
 * layer — the shape that returns `raster_unavailable` on the edge) goes
 * through sharp rasterization → onnxruntime-node PP-OCRv4 → gated text.
 *
 * Skipped unless apps/runner/models/rapidocr/ exists — run
 * `npm run fetch-models` first. The fixture is committed (no canvas needed).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "..", "models", "rapidocr");
const FIXTURE = resolve(HERE, "fixtures", "scanned-text.pdf");
const MARKER = "LITEPARSE RUNNER 7349";

describe.skipIf(!existsSync(MODELS))("OCR pipeline (real models)", { timeout: 120_000 }, () => {
  it("extracts the marker from a scanned PDF via local OCR (source=ocr, no vlm)", async () => {
    const service = createLiteparseService();
    const doc = await service(
      new Uint8Array(readFileSync(FIXTURE)),
      "scanned-text.pdf",
      undefined, // NO vlm config → proves OCR carried the parse, not a vision model
      new AbortController().signal,
    );

    expect(doc.text.toUpperCase()).toContain("7349"); // marker digits survive OCR noise
    expect(doc.source).toBe("ocr");
    expect(doc.pages.length).toBe(1);
  });

  it("recognizes the fixture through the full app (POST /parse shape)", async () => {
    const { createApp } = await import("../src/app.js");
    const { createSttService } = await import("../src/stt-service.js");
    const app = createApp({
      apiKey: "k-test",
      version: "0.0.0-test",
      service: createLiteparseService(),
      sttService: createSttService({}), // unused on /parse; real wiring, no warm
      maxBytes: 20 * 1024 * 1024,
      maxTotalMs: 110_000,
      maxConcurrency: 2,
      ocrReady: () => true,
      sttReady: () => false,
      startedAt: Date.now(),
    });
    const data = readFileSync(FIXTURE).toString("base64");
    const res = await app.request("/parse", {
      method: "POST",
      headers: { "x-api-key": "k-test", "content-type": "application/json" },
      body: JSON.stringify({ data, filename: "scanned-text.pdf" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; source: string; page_count: number; warnings: string[] };
    expect(body.source).toBe("ocr");
    expect(body.page_count).toBe(1);
    expect(body.text.toUpperCase()).toContain("7349");
    expect(body.warnings.join("\n")).not.toMatch(/raster_unavailable|vlm/);
  });
});
