import type { SttGateway, SttTranscribeOptions } from "../types.js";

/**
 * Reference server/edge SttGateway for an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (e.g. an AI gateway proxying
 * `gpt-4o-transcribe`). The audio is sent as multipart/form-data — the shape
 * every OpenAI-compatible transcriptions API expects.
 *
 * Mirrors {@link createServerVlmGateway} (`@drmoyassine/liteparse/vlm/server`): zero provider
 * coupling beyond the OpenAI-compatible wire format, key via header, and the
 * resolve-`{ text: "" }`-never-throw contract so the liteparse cascade can fall
 * through when the gateway can't transcribe.
 *
 * On Supabase Edge Functions / Node:
 *
 *   const stt = createServerSttGateway({
 *     endpoint: "https://ai.gateway.lovable.dev/v1/audio/transcriptions",
 *     keyHeader: "Lovable-API-Key",
 *     apiKey: LOVABLE_API_KEY,
 *     model: "gpt-4o-transcribe",
 *   });
 *   const { text } = await parseDocument(bytes, { stt, filename: "note.wav" });
 */
export interface ServerSttOptions {
  /** transcriptions URL. */
  endpoint: string;
  /** API key for the gateway. */
  apiKey: string;
  /** Transcription model id (e.g. "gpt-4o-transcribe"). */
  model: string;
  /**
   * Custom header carrying the key (e.g. "Lovable-API-Key"). If omitted, the key
   * is sent as `Authorization: Bearer <apiKey>`.
   */
  keyHeader?: string;
  /** Default spoken-language hint; per-call `opts.language` wins. */
  language?: "en" | "ar";
  /**
   * Sampling temperature. Defaults to 0 — verbatim transcription must be
   * deterministic (same rationale as the VLM gateway: an unset temperature lets
   * the provider emit a different reading of the same audio per call).
   */
  temperature?: number;
  /** Request timeout in ms. Default 60s (audio uploads are slow). */
  timeoutMs?: number;
}

/** Map an audio filename to the MIME most providers expect for it. */
function audioMime(opts: SttTranscribeOptions): string {
  if (opts.mime) return opts.mime;
  const ext = opts.filename?.includes(".")
    ? opts.filename.slice(opts.filename.lastIndexOf(".") + 1).toLowerCase()
    : undefined;
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "webm":
      return "audio/webm";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    default:
      return "audio/wav"; // the runner's canonical interchange format
  }
}

/**
 * Combine the caller's signal and a timeout into one signal, without
 * `AbortSignal.any` (Node 18 lacks it). Returns a cleanup fn that must run in
 * `finally` so the timer/listener can't leak on the happy path.
 */
function linkedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export function createServerSttGateway(opts: ServerSttOptions): SttGateway {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    async transcribe(
      audio: Uint8Array,
      ctx: SttTranscribeOptions = {},
    ): Promise<{ text: string; language?: string }> {
      const linked = linkedSignal(ctx.signal, timeoutMs);
      try {
        // FormData + Blob are global in Node 18+, Deno, and browsers; the
        // multipart boundary is set automatically. `file` (not `audio`) is the
        // field name the OpenAI transcriptions API expects.
        const form = new FormData();
        form.append(
          "file",
          new Blob([audio as BlobPart], { type: audioMime(ctx) }),
          ctx.filename ?? "audio.wav",
        );
        form.append("model", opts.model);
        form.append("response_format", "json");
        const language = ctx.language ?? opts.language;
        if (language) form.append("language", language);
        const temperature = opts.temperature ?? 0;
        if (temperature > 0) form.append("temperature", String(temperature));

        const headers: Record<string, string> = {};
        if (opts.keyHeader) headers[opts.keyHeader] = opts.apiKey;
        else headers["Authorization"] = `Bearer ${opts.apiKey}`;

        const res = await fetch(opts.endpoint, {
          method: "POST",
          headers,
          body: form,
          signal: linked.signal,
        });
        if (!res.ok) {
          // Never throw (gateway contract): "" lets the cascade degrade. The key
          // is never logged — only the status and a short body excerpt.
          const body = await res.text().catch(() => "");
          console.warn(
            `[stt-gateway] HTTP ${res.status}: ${body.slice(0, 200)}`,
          );
          return { text: "" };
        }
        const json = (await res.json()) as { text?: string; language?: string };
        return { text: (json.text ?? "").trim(), language: json.language };
      } catch (err) {
        if (ctx.signal?.aborted) throw err; // caller-initiated abort propagates
        console.warn(`[stt-gateway] request failed: ${(err as Error).message}`);
        return { text: "" };
      } finally {
        linked.cleanup();
      }
    },
  };
}
