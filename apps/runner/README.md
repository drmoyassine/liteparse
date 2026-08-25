# liteparse parse runner

A self-hosted HTTP service that gives **server-side parses full parity with the
browser runtime**: PDF rasterization (pdf.js + `@napi-rs/canvas` + sharp),
local OCR (PP-OCRv4 via `onnxruntime-node`), and optional caller-supplied VLM
fallback — one process, one container, no serverless canvas limits.

It exists because serverless runtimes (Supabase edge included) have no canvas:
scanned/image PDFs — photographed passports, licences, bank statements —
cannot be rasterized there, so document parsing for the agent (studygram's
DEC-082 `parse_document`) returns `raster_unavailable` for exactly the
documents that need OCR most. This runner is that missing runtime.

## API reference

Mirrors studygram's `parse-document` edge function exactly, so anything that can
POST JSON with an API-key header can parse documents — studygram's edge
functions, n8n workflows, scripts.

### `POST /parse`

Auth: **`X-API-Key: <PARSE_RUNNER_API_KEY>`** header on every call (timing-safe
compare). Missing/wrong key → `401 {"error":"unauthorized"}`.

**Request body** (JSON):

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | string | ✔ | Document bytes, **base64-encoded** |
| `filename` | string | — | Used for format classification; keep the real extension (`scan.pdf`, `passport.jpg`, `cv.docx`). Falls back to `document` |
| `options` | object | — | All keys optional — see below |

**`options`** (all optional):

| Field | Type | Default | Notes |
|---|---|---|---|
| `maxPages` | number | `20` | Clamped 1–50 |
| `perPageTimeoutMs` | number | `60000` | Clamped 1s–120s. Dense scans can take 20–30s/page on the VLM leg |
| `maxChars` | number | library default | Clamped 100k–200k |
| `vlm` | object | — | **Fallback-only** vision config (see below). Without it the runner is local-only: text-layer + OCR, no vision leg |

**`options.vlm`** — optional vision fallback, OpenAI-compatible endpoint. The
runner never persists it; the `apiKey` is redacted from every log line and
error response.

| Field | Type | Required | Notes |
|---|---|---|---|
| `endpoint` | string | ✔ | Chat-completions URL (`https://…/v1/chat/completions`) |
| `apiKey` | string | ✔ | Sent as `Authorization: Bearer <key>` unless `keyHeader` set |
| `model` | string | ✔ | Vision-capable model name |
| `keyHeader` | string | — | Custom auth header name instead of `Authorization` |
| `maxTokens` | number | `2000` | |
| `temperature` | number | `0` | Transcription is deterministic work — leave at 0 |

**Response `200`** (JSON):

| Field | Type | Meaning |
|---|---|---|
| `text` | string | Full extracted text (joined pages). Empty string = nothing extractable — **never fabricated** |
| `kind` | string | Detected format: `pdf`, `image`, `docx`, `xlsx`, `csv`, `other` |
| `source` | string | Which stage produced the text: `native` (text layer / structured text), `ocr` (local PP-OCRv4), `vlm` (vision fallback), `none` (no text found) |
| `page_count` | number | Pages processed |
| `warnings` | string[] | Non-fatal notes, e.g. `rapidocr-server: 0 non-ws chars across 1 page(s), falling through`, `vlm: …`. A `200` with empty `text` + warnings is an honest no-text result — surface the warnings, don't guess |
| `duration_ms` | number | Server-side wall time |

**Errors** (`{"error": "…"}`):

| Status | When |
|---|---|
| `400` | Non-JSON body, missing/empty `data`, invalid base64, 0-byte document |
| `401` | Missing/wrong `X-API-Key` |
| `405` | Non-POST on `/parse` |
| `413` | Decoded document over `RUNNER_MAX_BYTES` (20 MB default) |
| `503` | Concurrency slots full — respects `Retry-After: 2` |
| `500` | Parse failed (incl. the 110s whole-request deadline). Honest message |

**Limits & behavior to plan around:** decoded size cap 20 MB; whole-request
deadline 110 s (set your client timeout ≥ 120 s); 2 concurrent parses by
default (`RUNNER_MAX_CONCURRENCY`); `503` + `Retry-After` when full. Local OCR
first — the VLM leg only runs when local extraction yields nothing, so calls
**without** `options.vlm` never touch an external model.

### `GET /health`

Unauthenticated (uptime probes):

```json
{ "ok": true, "version": "0.3.0", "uptime_s": 3600, "ocr": "ready" }
```

`ocr: "unavailable"` means models failed to load — parses still work for
text-layer documents but not scanned ones.

### `curl` example

```bash
curl -s https://<runner-host>/parse \
  -H "X-API-Key: $PARSE_RUNNER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"data\": \"$(base64 -w0 scan.pdf)\", \"filename\": \"scan.pdf\"}"
```

### n8n example (HTTP Request node)

- **Method:** POST · **URL:** `https://<runner-host>/parse`
- **Headers:** `X-API-Key` = your key
- **Body (JSON):**

```json
{
  "data": "{{ $binary.data.data }}",
  "filename": "{{ $binary.data.fileName }}"
}
```

`$binary.data.data` is n8n's base64 of the incoming file (e.g. from a Telegram/
WhatsApp/Email trigger). Read `text` off the response; check `source` and
`warnings` before trusting empty results.

### Notes

- **No CORS.** Server-to-server only; a browser must never hold these keys.
- The caller's VLM `apiKey` is used for that request only, never logged
  (redacted), never persisted.
- The response body is byte-compatible with studygram's `parse-document` edge
  endpoint — a forwarder can pass it through unchanged.

## Run locally

```bash
cd apps/runner
npm install          # then check the repo root has no stray vite_react_shadcn_ts link
npm run fetch-models # one-time: PP-OCRv4 det+rec into ./models/rapidocr (gitignored)
npm run build
PARSE_RUNNER_API_KEY=dev-key npm start
curl localhost:3000/health
```

## Docker

Build from the **repo root** (context matters):

```bash
docker build -f apps/runner/Dockerfile -t liteparse-runner .
docker run -e PARSE_RUNNER_API_KEY=... -p 3000:3000 liteparse-runner
```

The image fetches sha256-pinned models at build (see the `models` stage —
pins printed by `npm run fetch-models`). `file:../..` is installed as a
packed tarball, not a symlink, so the runtime tree is self-contained.

## Environment

| Var | Default | |
|---|---|---|
| `PARSE_RUNNER_API_KEY` | — | **required**; an open parse endpoint would spend VLM credits |
| `PORT` | `3000` | |
| `RAPIDOCR_MODEL_PATH` | `./models/rapidocr` | where the ONNX models live |
| `RUNNER_MAX_CONCURRENCY` | `2` | in-flight parses; excess → 503 |
| `RUNNER_MAX_TOTAL_MS` | `110000` | whole-request deadline |
| `RUNNER_MAX_BYTES` | `20971520` | decoded document cap (20 MB) |

## Tests

- `test/app.test.ts` — hermetic HTTP contract (auth, validation, limits, redaction)
- `test/options.test.ts` — request→ParseOptions mapping + clamps (pure)
- `test/ocr-pipeline.test.ts` — **real models**, skipped until `npm run fetch-models`:
  the committed scanned-PDF fixture must come back as `source:"ocr"` with the
  marker text and zero warnings — the parity proof.
