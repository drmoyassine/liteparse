import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerSttGateway } from "../src/stt/gateway.server.js";
import type { ServerSttOptions } from "../src/stt/gateway.server.js";
import type { SttGateway } from "../src/types.js";

/**
 * Tests for src/stt/gateway.server.ts — the reference external-STT gateway
 * (OpenAI-compatible /v1/audio/transcriptions). fetch is stubbed; the multipart
 * body is inspected through the real FormData. Locks the VlmGateway-style
 * contract: resolve { text: "" } on any failure, never throw (except caller
 * abort), never log the key.
 */

const OPTS: ServerSttOptions = {
  endpoint: "https://gw.example/v1/audio/transcriptions",
  apiKey: "sk-secret-do-not-log",
  model: "gpt-4o-transcribe",
};

const CLIP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);

type FetchMock = ReturnType<typeof vi.fn>;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): FetchMock {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read a captured fetch init's FormData body (undici exposes FormData directly). */
function formOf(mock: FetchMock, call = 0): FormData {
  const init = mock.mock.calls[call]?.[1] as RequestInit | undefined;
  expect(init?.body).toBeInstanceOf(FormData);
  return init!.body as FormData;
}

/**
 * A fetch stub that behaves like real fetch for aborts: never settles on its
 * own, but rejects the moment its signal fires. (A plain never-settling promise
 * would swallow aborts — real fetch rejects on them.)
 */
function fetchThatHangsUntilAborted(): FetchMock {
  return stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createServerSttGateway — happy path", () => {
  it("POSTs multipart to the endpoint and returns trimmed text", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "  hello world  " }));
    const gw = createServerSttGateway(OPTS);
    const out = await gw.transcribe(CLIP, { filename: "note.wav" });

    expect(out.text).toBe("hello world");
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPTS.endpoint);
    expect(init.method).toBe("POST");
  });

  it("sends file (with filename + sniffed mime), model, and response_format=json", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "hi" }));
    const gw = createServerSttGateway(OPTS);
    await gw.transcribe(CLIP, { filename: "note.mp3" });

    const form = formOf(mock);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("note.mp3");
    expect((file as File).type).toBe("audio/mpeg"); // from the .mp3 extension
  });

  it("prefers an explicit mime over the filename extension, defaulting to audio/wav", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "hi" }));
    const gw = createServerSttGateway(OPTS);
    await gw.transcribe(CLIP, { filename: "clip.bin", mime: "audio/webm" });
    expect((formOf(mock, 0).get("file") as File).type).toBe("audio/webm");

    await gw.transcribe(CLIP); // no filename, no mime
    expect((formOf(mock, 1).get("file") as File).type).toBe("audio/wav");
    expect((formOf(mock, 1).get("file") as File).name).toBe("audio.wav");
  });

  it("appends language when provided (per-call wins over the gateway default)", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "مرحبا" }));
    const gw = createServerSttGateway({ ...OPTS, language: "en" });
    await gw.transcribe(CLIP, { language: "ar" });
    expect(formOf(mock).get("language")).toBe("ar");
  });

  it("omits language (auto-detect) and temperature 0 by default", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "hi" }));
    const gw = createServerSttGateway(OPTS);
    await gw.transcribe(CLIP);
    const form = formOf(mock);
    expect(form.get("language")).toBeNull();
    expect(form.get("temperature")).toBeNull();
  });

  it("appends temperature when explicitly > 0", async () => {
    const mock = stubFetch(async () => jsonRes({ text: "hi" }));
    const gw = createServerSttGateway({ ...OPTS, temperature: 0.4 });
    await gw.transcribe(CLIP);
    expect(formOf(mock).get("temperature")).toBe("0.4");
  });

  it("sends the key as Authorization: Bearer by default, or via keyHeader", async () => {
    const bearer = stubFetch(async () => jsonRes({ text: "hi" }));
    await createServerSttGateway(OPTS).transcribe(CLIP);
    const bearerInit = bearer.mock.calls[0]?.[1] as RequestInit;
    expect((bearerInit.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${OPTS.apiKey}`,
    );

    const custom = stubFetch(async () => jsonRes({ text: "hi" }));
    await createServerSttGateway({ ...OPTS, keyHeader: "Lovable-API-Key" }).transcribe(CLIP);
    const customInit = custom.mock.calls[0]?.[1] as RequestInit;
    const headers = customInit.headers as Record<string, string>;
    expect(headers["Lovable-API-Key"]).toBe(OPTS.apiKey);
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("createServerSttGateway — degradation (never throw, never log the key)", () => {
  it("resolves {text:''} on a non-2xx response and does not echo the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => jsonRes({ error: { message: "bad audio" } }, 422));
    const gw = createServerSttGateway(OPTS);

    const out = await gw.transcribe(CLIP);
    expect(out.text).toBe("");
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c.join(" "))).join(" ");
    expect(logged).not.toContain(OPTS.apiKey);
    expect(logged).toContain("422");
  });

  it("resolves {text:''} on a network failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => {
      throw new Error("ECONNRESET");
    });
    const out = await createServerSttGateway(OPTS).transcribe(CLIP);
    expect(out.text).toBe("");
  });

  it("resolves {text:''} when the response body is not JSON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => new Response("<html>gateway error</html>", { status: 200 }));
    const out = await createServerSttGateway(OPTS).transcribe(CLIP);
    expect(out.text).toBe("");
  });

  it("resolves {text:''} on timeout without hanging", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Hangs until aborted: only the gateway's own timeout can end the call.
    fetchThatHangsUntilAborted();
    const gw = createServerSttGateway({ ...OPTS, timeoutMs: 25 });
    const out = await gw.transcribe(CLIP);
    expect(out.text).toBe("");
  });

  it("propagates a caller-initiated abort (cancellation is not a degraded result)", async () => {
    fetchThatHangsUntilAborted();
    const ac = new AbortController();
    const gw = createServerSttGateway({ ...OPTS, timeoutMs: 5_000 });
    const p = gw.transcribe(CLIP, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
