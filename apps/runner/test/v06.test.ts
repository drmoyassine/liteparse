import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { OcrPageService, ParseService } from "../src/service.js";
import type { SttService } from "../src/stt-service.js";
import { pickResponseMode } from "../src/handlers/parse.js";
import { createLibreOfficeConverter } from "../src/libreoffice.js";
import { loadConfig } from "../src/config.js";
import type { Page, ParsedDocument } from "@drmoyassine/liteparse";

const pages: Page[] = [
  { index: 0, pageNumber: 1, text: "first", source: "native", method: "native", engine: "pdfjs-text" },
  { index: 1, pageNumber: 2, text: "ثاني", source: "ocr", method: "ocr", engine: "rapidocr-server", reason: "scanned", script: "arabic" },
];
const doc: ParsedDocument = {
  text: "first\n\nثاني",
  source: "mixed",
  pages,
  warnings: [],
  kind: "pdf",
  meta: { pagesProcessed: 2, totalPages: 2, nativePages: 1, ocrPages: 1, vlmPages: 0, sttPages: 0, truncated: false, chars: 11 },
};

function build(over: { service?: ParseService; ocrService?: OcrPageService; responseMode?: "stream" | "json"; pageOutput?: "per-page" | "single" } = {}) {
  const service =
    over.service ??
    (vi.fn(async (_b, _f, _o, _s, hooks?: { onPage?: (p: Page) => void }) => {
      for (const p of pages) hooks?.onPage?.(p);
      return doc;
    }) as unknown as ParseService);
  const app = createApp({
    apiKey: "k",
    version: "test",
    service,
    ocrService: over.ocrService,
    sttService: vi.fn() as unknown as SttService,
    maxTotalMs: 5_000,
    responseMode: over.responseMode,
    pageOutput: over.pageOutput,
    ocrReady: () => true,
    sttReady: () => true,
  });
  return { app, service: service as unknown as ReturnType<typeof vi.fn> };
}

const body = JSON.stringify({ data: Buffer.from("%PDF-fake").toString("base64"), filename: "a.pdf" });

describe("POST /parse — 0.6 response modes", () => {
  it("streams NDJSON by default: one line per page, then the result", async () => {
    const { app } = build();
    const res = await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["page", "page", "result"]);
    expect(lines[1]).toMatchObject({ page: 2, method: "ocr", reason: "scanned", script: "arabic" });
    expect(lines[2].pages).toHaveLength(2);
    expect(lines[2].source).toBe("mixed");
  });

  it("returns one JSON body when Accept: application/json", async () => {
    const { app } = build();
    const res = await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json", accept: "application/json" }, body });
    const json = (await res.json()) as { pages: Array<{ page: number }>; page_count: number };
    expect(json.page_count).toBe(2);
    expect(json.pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("RUNNER_RESPONSE_MODE=json default, overridable by Accept: application/x-ndjson", async () => {
    const { app } = build({ responseMode: "json" });
    const res = await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body });
    expect(res.headers.get("content-type")).toContain("application/json");
    const res2 = await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json", accept: "application/x-ndjson" }, body });
    expect(res2.headers.get("content-type")).toContain("application/x-ndjson");
    expect(pickResponseMode("*/*", "stream")).toBe("stream");
  });

  it("applies the RUNNER_PAGE_OUTPUT default, and a per-request pageOutput overrides it", async () => {
    const { app, service } = build({ pageOutput: "single", responseMode: "json" });
    await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body });
    expect(service.mock.calls[0]![2].pageOutput).toBe("single");
    const b2 = JSON.stringify({ ...JSON.parse(body), options: { pageOutput: "per-page" } });
    await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body: b2 });
    expect(service.mock.calls[1]![2].pageOutput).toBe("per-page");
  });

  it("streams an error line (not a hung response) when the service throws", async () => {
    const { app } = build({ service: vi.fn(async () => { throw new Error("boom Bearer abc.def"); }) as unknown as ParseService });
    const res = await app.request("/parse", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body });
    const line = JSON.parse((await res.text()).trim());
    expect(line.type).toBe("error");
    expect(line.error).toContain("Bearer ***");
  });
});

describe("POST /ocr — browser → runner page fallback", () => {
  it("requires the key and runs the page through the OCR service with the script", async () => {
    const ocr = vi.fn(async (_png: Uint8Array, _ctx: Record<string, unknown>) => ({ text: "مرحبا", confidence: 0.93, script: "arabic", totalBoxes: 4, droppedBoxes: 0 }));
    const { app } = build({ ocrService: ocr as unknown as OcrPageService });
    const req = { data: Buffer.from("png").toString("base64"), script: "arabic", pageNumber: 3, totalPages: 9 };
    expect((await app.request("/ocr", { method: "POST", body: JSON.stringify(req) })).status).toBe(401);
    const res = await app.request("/ocr", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body: JSON.stringify(req) });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ text: "مرحبا", script: "arabic", total_boxes: 4, dropped_boxes: 0 });
    expect(ocr.mock.calls[0]![1]).toMatchObject({ script: "arabic", pageIndex: 2, totalPages: 9 });
  });

  it("503s when OCR is not configured", async () => {
    const { app } = build();
    const res = await app.request("/ocr", { method: "POST", headers: { "x-api-key": "k" }, body: JSON.stringify({ data: "AAAA" }) });
    expect(res.status).toBe(503);
  });
});

describe("runner config + LibreOffice fallback", () => {
  it("0.6 defaults: 100 MB, 300 OCR pages, 2,000,000 chars, stream, per-page, lazy LibreOffice", () => {
    const c = loadConfig({ PARSE_RUNNER_API_KEY: "x" });
    expect(c.maxBytes).toBe(100 * 1024 * 1024);
    expect(c.maxOcrPages).toBe(300);
    expect(c.maxChars).toBe(2_000_000);
    expect(c.responseMode).toBe("stream");
    expect(c.pageOutput).toBe("per-page");
    expect(c.libreoffice.mode).toBe("lazy");
    const j = loadConfig({ PARSE_RUNNER_API_KEY: "x", RUNNER_RESPONSE_MODE: "json", RUNNER_PAGE_OUTPUT: "single", LIBREOFFICE_MODE: "off" });
    expect([j.responseMode, j.pageOutput, j.libreoffice.mode]).toEqual(["json", "single", "off"]);
  });

  it("mode off never converts; lazy without a pinned archive degrades to null", async () => {
    expect(await createLibreOfficeConverter({ mode: "off", cacheDir: "/tmp/x" })(new Uint8Array([1]), "a.doc")).toBeNull();
    const lazy = createLibreOfficeConverter({ mode: "lazy", cacheDir: `/tmp/lo-test-${Date.now()}` });
    expect(await lazy(new Uint8Array([1]), "a.doc")).toBeNull();
  });
});

import { execSync } from "node:child_process";
const haveSoffice = (() => {
  try {
    execSync("command -v soffice", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveSoffice)("LibreOffice fallback (preinstalled soffice)", () => {
  it("converts an office file to PDF bytes", async () => {
    const { readFileSync } = await import("node:fs");
    const convert = createLibreOfficeConverter({ mode: "preinstalled", cacheDir: "/tmp/x" });
    const odt = new Uint8Array(readFileSync(new URL("../../../test/fixtures/formats/doc.odt", import.meta.url)));
    const pdf = await convert(odt, "doc.odt");
    expect(pdf).not.toBeNull();
    expect(new TextDecoder().decode(pdf!.subarray(0, 4))).toBe("%PDF");
  }, 120_000);
});
