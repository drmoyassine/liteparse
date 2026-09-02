/**
 * The runner's OpenAPI 3.1 document, hand-maintained against the README's API
 * reference (the two must stay in sync — tests pin the paths, not the prose).
 * Served unauthenticated at /openapi.json; /docs renders it via Swagger UI.
 * The spec is a static literal, not derived from handlers: the surface is three
 * endpoints that change rarely, and a schema-library refactor of the hand-rolled
 * validation ladder would buy nothing.
 */
export function createOpenApiDocument(version: string): Record<string, unknown> {
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });
  const authed = [{ ApiKeyAuth: [] }];

  return {
    openapi: "3.1.0",
    info: {
      title: "liteparse parse runner",
      version,
      description:
        "Self-hosted document + speech extraction with browser parity: PDF/Office text, " +
        "local PP-OCRv4 OCR, local Moonshine STT (EN/AR), optional caller-supplied VLM/STT " +
        "gateways as fallback only. One process, one container, no serverless canvas limits. " +
        "The /parse response body is byte-compatible with studygram's parse-document edge " +
        "endpoint. No CORS — server-to-server only; a browser must never hold the API key. " +
        "Caller gateway apiKey values are redacted from every log line and error response. " +
        "/parse and /transcribe share ONE concurrency budget (RUNNER_MAX_CONCURRENCY, " +
        "default 2): a heavy request on either can 503 the other.",
    },
    servers: [{ url: "/", description: "this runner (use your deployment's base URL)" }],
    security: authed,
    tags: [
      { name: "parse", description: "Document text extraction" },
      { name: "transcribe", description: "Speech-to-text with a local-first escalation walk" },
      { name: "ops", description: "Unauthenticated operational endpoints" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["ops"],
          summary: "Uptime probe + engine readiness",
          description:
            "The only unauthenticated data route. ocr/stt report \"unavailable\" until the " +
            "models warm at boot — /parse still works for text-layer documents, /transcribe " +
            "still serves gateway-configured requests.",
          security: [],
          responses: {
            200: {
              description: "Runner state",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Health" } },
              },
            },
          },
        },
      },
      "/parse": {
        post: {
          tags: ["parse"],
          summary: "Extract text from a document",
          description:
            "Local-first cascade: native text layer → local PP-OCRv4 OCR → optional caller " +
            "VLM fallback. Without options.vlm the runner never touches an external model. " +
            "Empty text + warnings is an honest no-text result — surface the warnings, don't guess.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ParseRequestBody" } },
            },
          },
          responses: {
            200: {
              description: "Extraction result (text may be empty — never fabricated)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ParseResponse" } },
              },
            },
            400: errorResponse("Non-JSON body, missing/empty data, invalid base64, 0-byte document"),
            401: errorResponse("Missing/wrong X-API-Key"),
            405: errorResponse("Non-POST on /parse"),
            413: errorResponse("Decoded document over RUNNER_MAX_BYTES (20 MB default)"),
            503: {
              description: "Concurrency slots full — respects Retry-After: 2",
              headers: {
                "Retry-After": { schema: { type: "string" }, description: "Seconds to wait (\"2\")" },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            500: errorResponse("Parse failed (incl. the 110 s whole-request deadline)"),
          },
        },
      },
      "/transcribe": {
        post: {
          tags: ["transcribe"],
          summary: "Transcribe speech (local-first escalation)",
          description:
            "Slot 1: Moonshine streaming-tiny (EN or AR per options.language) → on low " +
            "confidence, EN escalates to slot 2 Moonshine base-en → then (any language) to the " +
            "caller's STT gateway if provided. THE AUDIO CONTRACT IS WAV PCM16 (mono 16 kHz " +
            "ideal; other rates/channels are mixed + resampled server-side) — browsers decode " +
            "webm/opus/m4a client-side and POST the WAV. Anything else is a 422 naming the contract.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TranscribeRequestBody" } },
            },
          },
          responses: {
            200: {
              description: "Transcript (empty text + warnings = honest no-speech)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/TranscribeResponse" } },
              },
            },
            400: errorResponse("Bad body/base64/options shape"),
            401: errorResponse("Missing/wrong X-API-Key"),
            405: errorResponse("Non-POST on /transcribe"),
            413: errorResponse("Decoded audio over RUNNER_STT_MAX_BYTES (25 MB default)"),
            422: errorResponse("Not WAV PCM16 — the message names the contract"),
            503: {
              description:
                "Concurrency slots full (shared with /parse) or no local model AND no gateway",
              headers: {
                "Retry-After": { schema: { type: "string" }, description: "Seconds to wait (\"2\")" },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            500: errorResponse("Decode failure (incl. the 60 s whole-request deadline)"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "PARSE_RUNNER_API_KEY — timing-safe compared",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        Health: {
          type: "object",
          required: ["ok", "version", "uptime_s", "ocr", "stt"],
          properties: {
            ok: { type: "boolean", const: true },
            version: { type: "string" },
            uptime_s: { type: "integer" },
            ocr: { enum: ["ready", "unavailable"] },
            stt: { enum: ["ready", "unavailable"] },
          },
        },
        VlmConfig: {
          type: "object",
          description: "Fallback-only vision leg. Never persisted; apiKey redacted everywhere.",
          required: ["endpoint", "apiKey", "model"],
          properties: {
            endpoint: { type: "string", description: "Chat-completions URL (https://…/v1/chat/completions)" },
            apiKey: { type: "string", writeOnly: true },
            model: { type: "string", description: "Vision-capable model name" },
            keyHeader: { type: "string", description: "Custom auth header instead of Authorization" },
            maxTokens: { type: "integer", default: 2000 },
            temperature: { type: "number", default: 0 },
          },
        },
        SttConfig: {
          type: "object",
          description: "Escalation-only external gateway (the AR quality ceiling). Never persisted.",
          required: ["endpoint", "apiKey", "model"],
          properties: {
            endpoint: { type: "string", description: "Transcriptions URL (OpenAI-compatible /v1/audio/transcriptions)" },
            apiKey: { type: "string", writeOnly: true },
            model: { type: "string", description: "e.g. gpt-4o-transcribe" },
            keyHeader: { type: "string", description: "Custom auth header" },
            temperature: { type: "number", default: 0 },
          },
        },
        ParseRequestBody: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "string", contentEncoding: "base64", description: "Document bytes, base64-encoded" },
            filename: {
              type: "string",
              description: "Used for format classification; keep the real extension (scan.pdf, passport.jpg, cv.docx). Falls back to \"document\"",
            },
            options: { $ref: "#/components/schemas/ParseOptions" },
          },
        },
        ParseOptions: {
          type: "object",
          properties: {
            maxPages: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            perPageTimeoutMs: {
              type: "integer",
              default: 60000,
              description: "Clamped 1 s–120 s. Dense scans can take 20–30 s/page on the VLM leg",
            },
            maxChars: { type: "integer", description: "Clamped 100k–200k (library default when omitted)" },
            vlm: { $ref: "#/components/schemas/VlmConfig" },
          },
        },
        ParseResponse: {
          type: "object",
          required: ["text", "kind", "source", "page_count", "warnings", "duration_ms"],
          properties: {
            text: { type: "string", description: "Full extracted text (joined pages). Empty = nothing extractable" },
            kind: { enum: ["pdf", "image", "docx", "xlsx", "csv", "other"] },
            source: {
              enum: ["native", "ocr", "vlm", "none"],
              description: "Which stage produced the text",
            },
            page_count: { type: "integer" },
            warnings: { type: "array", items: { type: "string" } },
            duration_ms: { type: "integer" },
          },
        },
        TranscribeRequestBody: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "string", contentEncoding: "base64", description: "WAV PCM16 audio bytes, base64-encoded" },
            filename: { type: "string" },
            options: { $ref: "#/components/schemas/TranscribeOptions" },
          },
        },
        TranscribeOptions: {
          type: "object",
          properties: {
            language: { enum: ["en", "ar"], default: "en", description: "Picks the slot-1 model (EN/AR streaming tiny)" },
            keepDiacritics: { type: "boolean", default: false, description: "Default strips Arabic tashkeel" },
            stt: { $ref: "#/components/schemas/SttConfig" },
          },
        },
        TranscribeResponse: {
          type: "object",
          required: ["text", "language", "engine", "confidence", "warnings", "duration_ms"],
          properties: {
            text: { type: "string", description: "Transcript. Empty + warnings = honest no-speech" },
            language: { enum: ["en", "ar"] },
            engine: {
              enum: [
                "moonshine-streaming-tiny-en",
                "moonshine-streaming-tiny-ar",
                "moonshine-batch-base-en",
                "stt-gateway",
              ],
              description: "Model id that produced the text",
            },
            confidence: {
              type: ["number", "null"],
              description: "Local mean per-token probability (floor 0.55, uncalibrated); null when the gateway produced the text",
            },
            warnings: { type: "array", items: { type: "string" } },
            duration_ms: { type: "integer" },
          },
        },
      },
    },
  };
}
