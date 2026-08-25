import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermetic tests for the RapidOCR server engine: model-path detection, error
 * paths, and the recognize() contract — all with onnxruntime-node and
 * @napi-rs/canvas MOCKED (no model binaries needed; real-model OCR runs in
 * apps/runner's ocr-pipeline test, which skips when models are absent).
 *
 * The engine keeps module-level singletons, so every test loads a FRESH module
 * copy (vi.resetModules + doMock) against its own mocks.
 */

// ── mock builders ─────────────────────────────────────────────────────────────

/** A det/rec session pair over an all-ZERO [1,1,8,8] prob map → detection finds 0 boxes. */
function mockOrtFactory() {
  const create = vi.fn(async (path: string) => ({
    inputNames: ["x"],
    outputNames: ["prob"],
    run: vi.fn(async () => ({
      prob: { dims: [1, 1, 8, 8], data: new Float32Array(64) }, // all-zero probability map
    })),
    release: vi.fn(),
    path,
  }));
  class FakeTensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  return { InferenceSession: { create }, Tensor: FakeTensor };
}

/** All-white canvas: getImageData returns 255s so preprocess math stays finite. */
function mockCanvasFactory() {
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }),
  };
  const createCanvas = vi.fn((w: number, h: number) => ({
    width: w,
    height: h,
    getContext: () => ctx,
  }));
  const loadImage = vi.fn(async () => ({ width: 120, height: 60 }));
  return { createCanvas, loadImage };
}

/** Load a fresh module copy with the given (or default) native mocks installed. */
async function freshModule(
  opts: { ortFactory?: () => unknown; canvasFactory?: () => unknown } = {},
) {
  vi.resetModules();
  vi.doMock("onnxruntime-node", () =>
    (opts.ortFactory ?? mockOrtFactory)() as Record<string, unknown>,
  );
  vi.doMock("@napi-rs/canvas", () =>
    (opts.canvasFactory ?? mockCanvasFactory)() as Record<string, unknown>,
  );
  return await import("../src/ocr/rapidocr-server.js");
}

/** Temp dir carrying fake v4 det/rec/dict files. */
function fakeModelDir(extra?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rapidocr-server-"));
  writeFileSync(join(dir, "ch_PP-OCRv4_det.onnx"), "fake-det");
  writeFileSync(join(dir, "en_PP-OCRv4_rec_infer.onnx"), "fake-rec");
  // CRLF + blank lines: loadDict must trim and drop empties without crashing.
  writeFileSync(join(dir, "ppocr-en-dict.txt"), "a\nb\r\n\n  c  \n\r\n");
  for (const [name, content] of Object.entries(extra ?? {})) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const prevEnv = process.env.RAPIDOCR_MODEL_PATH;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("onnxruntime-node");
  vi.doUnmock("@napi-rs/canvas");
  if (prevEnv === undefined) delete process.env.RAPIDOCR_MODEL_PATH;
  else process.env.RAPIDOCR_MODEL_PATH = prevEnv;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("createRapidOcrServerEngine — model loading", () => {
  it("rejects with an install hint when the native packages cannot be imported", async () => {
    const mod = await freshModule({
      ortFactory: () => {
        throw new Error("Cannot find module 'onnxruntime-node'");
      },
    });
    await expect(mod.createRapidOcrServerEngine()).rejects.toThrow(
      /onnxruntime-node and @napi-rs\/canvas/,
    );
  });

  it("rejects clearly when no model directory exists anywhere", async () => {
    delete process.env.RAPIDOCR_MODEL_PATH;
    const mod = await freshModule();
    await expect(mod.createRapidOcrServerEngine({ debug: false })).rejects.toThrow(
      /RapidOCR models not found/,
    );
  });

  it("fails loudly when RAPIDOCR_MODEL_PATH is set but missing", async () => {
    process.env.RAPIDOCR_MODEL_PATH = join(tmpdir(), "rapidocr-no-such-dir");
    const mod = await freshModule();
    await expect(mod.createRapidOcrServerEngine({ debug: false })).rejects.toThrow(
      /RAPIDOCR_MODEL_PATH is set but does not exist/,
    );
  });

  it("reports which model file is missing from an otherwise-valid directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rapidocr-server-partial-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "ch_PP-OCRv4_det.onnx"), "fake-det"); // rec + dict absent
    process.env.RAPIDOCR_MODEL_PATH = dir;
    const mod = await freshModule();
    await expect(mod.createRapidOcrServerEngine({ debug: false })).rejects.toThrow(
      /Recognition model not found/,
    );
  });

  it("opts.modelPath overrides RAPIDOCR_MODEL_PATH", async () => {
    const good = fakeModelDir();
    tempDirs.push(good);
    const bad = mkdtempSync(join(tmpdir(), "rapidocr-server-bad-")); // empty dir
    tempDirs.push(bad);
    process.env.RAPIDOCR_MODEL_PATH = bad; // would fail — must be overridden

    const ortFactory = mockOrtFactory();
    const mod = await freshModule({ ortFactory: () => ortFactory });
    const engine = await mod.createRapidOcrServerEngine({ modelPath: good, debug: false });
    expect(engine.name).toBe("rapidocr-server");
    expect(engine.available).toBe(true);
    const create = ortFactory.InferenceSession.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(String(call[0])).toContain(good);
    }
    engine.dispose();
  });

  it("loads the v4 artifacts from RAPIDOCR_MODEL_PATH and exposes a working engine", async () => {
    const dir = fakeModelDir();
    tempDirs.push(dir);
    process.env.RAPIDOCR_MODEL_PATH = dir;

    const mod = await freshModule();
    const engine = await mod.createRapidOcrServerEngine({ debug: false });
    expect(engine.name).toBe("rapidocr-server");
    expect(typeof engine.recognize).toBe("function");
    expect(typeof engine.dispose).toBe("function");
    engine.dispose();
  });
});

describe("rapidocr-server engine.recognize — contract (mocked pipeline)", () => {
  it("returns empty text / 0 confidence when detection finds no boxes", async () => {
    const dir = fakeModelDir();
    tempDirs.push(dir);
    process.env.RAPIDOCR_MODEL_PATH = dir;

    const mod = await freshModule();
    const engine = await mod.createRapidOcrServerEngine({ debug: false });
    const result = await engine.recognize(new Uint8Array([1, 2, 3]), {
      pageIndex: 0,
      totalPages: 1,
    });
    // All-zero det prob map → 0 boxes → no text, no gate trip (genuine no-text result).
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    engine.dispose();
  });

  it("throws immediately when the context signal is already aborted", async () => {
    const dir = fakeModelDir();
    tempDirs.push(dir);
    process.env.RAPIDOCR_MODEL_PATH = dir;

    const mod = await freshModule();
    const engine = await mod.createRapidOcrServerEngine({ debug: false });
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.recognize(new Uint8Array([1]), {
        pageIndex: 0,
        totalPages: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    engine.dispose();
  });
});
