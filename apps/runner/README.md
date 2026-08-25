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

## Contract

Mirrors studygram's `parse-document` edge function exactly.

```
POST /parse                     (X-API-Key header required)
{ "data": "<base64 bytes>", "filename": "scan.pdf",
  "options?": {
    "vlm?":    { "endpoint", "apiKey", "model", "keyHeader?", "maxTokens?", "temperature?" },
    "maxPages?", "perPageTimeoutMs?", "maxChars?"
  } }

→ 200 { "text", "kind", "source", "page_count", "warnings", "duration_ms" }
→ 400 bad JSON / missing data / invalid base64     401 bad key
→ 405 GET                                          413 document over RUNNER_MAX_BYTES
→ 503 concurrency full (Retry-After: 2)            500 honest error message
```

- `GET /health` — unauthenticated: `{ok, version, uptime_s, ocr: "ready"|"unavailable"}`
- **No CORS.** Server-to-server only; a browser must never hold these keys.
- The caller's VLM `apiKey` is used for that request only, never logged
  (redacted), never persisted.
- Option clamps: `maxPages` 1–50, `perPageTimeoutMs` 1s–120s (default 60s,
  caller parity), `maxChars` 100–200k.

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
