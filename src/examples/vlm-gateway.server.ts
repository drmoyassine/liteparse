import type { VlmGateway, VlmReadOptions } from "../types.js";

/**
 * Reference server/edge VlmGateway for an OpenAI-compatible chat-completions
 * endpoint that supports `image_url` (e.g. an AI gateway with a vision model).
 * The image is sent as a base64 data URL inside the `image_url` block.
 *
 * On Supabase Edge Functions / Deno, point this at your AI gateway:
 *
 *   const vlm = createServerVlmGateway({
 *     endpoint: "https://ai.gateway.lovable.dev/v1/chat/completions",
 *     keyHeader: "Lovable-API-Key",
 *     apiKey: LOVABLE_API_KEY,
 *     model: "google/gemini-3.6-flash",
 *   });
 *   const { text } = await parseDocument(bytes, { vlm, filename: "passport.jpg" });
 */
export interface ServerVlmOptions {
  /** chat-completions URL. */
  endpoint: string;
  /** API key for the gateway. */
  apiKey: string;
  /** Vision-capable model id. */
  model: string;
  /**
   * Custom header carrying the key (e.g. "Lovable-API-Key"). If omitted, the key
   * is sent as `Authorization: Bearer <apiKey>`.
   */
  keyHeader?: string;
  maxTokens?: number;
  /**
   * Sampling temperature. Defaults to 0 — this gateway is used for verbatim
   * transcription, which must be deterministic (an unset temperature let the
   * provider sample a different transcription of the same image per call).
   */
  temperature?: number;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.btoa === "function") return g.btoa(bin);
  return Buffer.from(bin, "binary").toString("base64");
}

export function createServerVlmGateway(opts: ServerVlmOptions): VlmGateway {
  return {
    async readImage(png: Uint8Array, ctx: VlmReadOptions = {}): Promise<string> {
      const mime = ctx.mime ?? "image/png";
      const instruction = ctx.hint
        ? `Transcribe all text in this image verbatim (${ctx.hint}). Output plain text only.`
        : "Transcribe all text in this image verbatim. Output plain text only.";

      const body = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(png)}` } },
            ],
          },
        ],
      };

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.keyHeader) headers[opts.keyHeader] = opts.apiKey;
      else headers["Authorization"] = `Bearer ${opts.apiKey}`;

      const res = await fetch(opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`vlm gateway HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (json.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}
