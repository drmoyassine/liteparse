# liteparse Roadmap — forward plan

> **Status:** live. Decided 2026-08-11.
> The router build (classify→route→execute, browser-first, ocr.space removed) is
> **complete** — its phase-by-phase build record now lives in
> [ROUTER_BUILD_PLAN.md](./ROUTER_BUILD_PLAN.md). This file is *what's next*.
> Pairs with [ARCHITECTURE.md](./ARCHITECTURE.md) (the *what*) and the
> `ocr-lab/calibrate.ts` calibration harness (the *truth source* for quality gates).

---

## The governing decision — TS-everywhere + the self-host boundary

Two rules hold the whole plan together. Every track below is shaped by them.

1. **TS-everywhere.** TypeScript across browser → edge → container → GPU worker.
   Runpod Serverless is the primary GPU target (runtime-agnostic, takes the Docker
   image as-is); Modal is optional only. Same `.onnx` models run on every tier —
   only the **execution provider** differs: `onnxruntime-web` (WASM/WebGPU) in the
   browser, `onnxruntime-node` (+ CUDA EP) in the server worker. The pipeline
   (classify→route→det→rec→dbPostProcess→reading-order→confidence gate) is reused
   wholesale; we add execution adapters, we don't rewrite the engine.
2. **Self-host boundary = perception models only.** The only models that run in our
   own runtime are OCR and STT. Reasoning (LLM/VLM) stays an **external
   OpenAI-compatible call**, exactly as today (the agent text LLM and VLM are already
   external). So "TS-everywhere" ≠ "no LLM in the stack" — it means LLMs stay a
   one-hop external call. Whisper lands on the self-host side; the LLM stays external.

**Honest ceiling this accepts:** Whisper via `onnxruntime-node` is good, not best (no
`faster-whisper`). Fine for voice-note clips; bulk long-form would use the external
STT fallback. OCR is first-class on every tier.

---

## Tracks (priority order)

### Track 1 — int8 quantization + recalibration · `[FOUNDATION]`

**Why first:** it's the force-multiplier. Smaller/faster models benefit *every* other
track — two rec models in memory (Track 2), Whisper viable in-browser (Track 3 v1),
and faster GPU-worker cold starts + more concurrent jobs per GPU (Track 4). int8 pays
off twice: browser (downloads/cache/RAM) **and** server (cold start, VRAM economics).

**Tasks**
- [ ] Obtain int8 quantized det + rec artifacts (RapidOCR publishes some; otherwise
      quantize with `onnxruntime` `quantize_dynamic`). Prefer **dynamic** quantization
      first (safer accuracy); move to static only if speed is insufficient.
- [ ] Add an int8 execution variant behind the existing engine interface (precision
      is a model-artifact property, not a new engine).
- [ ] **Re-run `scripts/ocr-lab/calibrate.ts` against the int8 model** before trusting
      the confidence gate — quantization shifts score distributions; the gate is
      calibrated against the current fp model. Re-derive `OCR_CONFIDENCE_FLOOR` +
      garbage-ratio thresholds vs vision-model ground truth.
- [ ] ModelOrigin: serve int8 as a versioned variant (S3 bucket); IndexedDB cache
      keys must distinguish int8 vs fp (version-skew = silent quality regression).
- [ ] Bench: warm latency, cold (download) bytes, peak RSS. Target ≥1.5× speedup on
      the rec pass (CPU/WASM), ~halved model bytes.

**Dependencies / blockers:** none — this is the foundation.
**Done when:** int8 path passes the recalibrated quality gate at parity-or-better vs fp,
build green, calibration deltas documented.

---

### Track 2 — In-browser bilingual (Latin + Arabic)

**Why:** real product gap (Arabic documents). Architecture is ready — `DocumentProfile.script`
already flows through the router; det is script-agnostic, only **rec** is per-script.

**Tasks**
- [ ] Add the Arabic rec model + dict (`ar_PP-OCRv4_rec_infer.onnx` + dict) to the
      ModelOrigin catalog, script-keyed.
- [ ] `recSession`/`dictChars` → `Map<Script, …>` (the deferred change from the
      `intelligent-document-router-design` memory). Single active rec session per script.
- [ ] **Per-document** script routing first: classify once → load one rec model.
      Covers ~95% of docs at half the complexity. Do NOT start with per-box routing.
- [ ] (Later) per-box fallback for mixed-script: run Latin, measure garbage ratio,
      re-run Arabic only on the boxes that failed — not both on everything.
- [ ] Confidence gate must re-validate per script (Arabic rec confidence distribution
      ≠ Latin; calibrate separately in `ocr-lab`).
- [ ] **Telemetry:** VLM-fallback rate by script. If a third language is frequent,
      adding its model beats paying VLM per doc (fallback is a safety net, not a strategy).

**Dependencies / blockers:** benefits hugely from Track 1 (two rec models in memory →
int8 smaller is the difference between fits and OOM on mid-range hardware).
**Done when:** an Arabic scanned PDF extracts cleanly via the browser path at quality
parity with the Latin baseline (calibrated), no VLM on the happy path.

---

### Track 3 — litecomposer (speech)

**Why:** turns liteparse from doc→text into media→text. The architecture (worker,
ModelOrigin, IndexedDB cache, router) maps directly onto audio. **Phased** — ship the
cheap half now, the local-model half later.

**v0 — ships now (no model, no WebGPU):**
- [ ] Web Speech API **live dictation** (mic button → text streams into composer with
      interim results). Note: Web Speech API is **vendor-cloud**, not a local model —
      closer to an external API call than to RapidOCR. Live-mic only, not file/blob.
      Firefox support absent. Treat as an *input method beside the pipeline*, not a
      stage inside it.
- [ ] **External OpenAI-compatible STT fallback** for files (`/v1/audio/transcriptions`).
      Route through the **same gateway pattern** as the VLM fallback
      (`app_settings.parse_vlm_account_id` → add `stt_account_id`). One external-model
      gateway abstraction, not a second parallel path.
- [ ] Graceful "mic/API not supported" → user types.

**v1 — ultimate vision (local in-browser Whisper):**
- [ ] **BLOCKED on the WebGPU compute backend existing** (see Cross-cutting: WebGPU is
      its own line, NOT folded into Track 1's int8 work). WASM Whisper is
      slower-than-real-time past tiny; WebGPU is the gate.
- [ ] Whisper in a Web Worker via the existing primitives (ModelOrigin, cache, singleton).
      Use `onnxruntime-web` WebGPU EP on the whisper.onnx model.
- [ ] **STT confidence gate** mirroring the OCR one — Whisper gives per-segment
      probabilities; gate on them. Build `stt-lab` calibration harness (analog of
      `ocr-lab`) to set "good enough vs fall back to external STT" thresholds.
- [ ] Engine dispose/evict: a Whisper session + OCR session in one tab is heavy —
      LRU evict or explicit dispose (the deferred engine-lifecycle work, repurposed).

**Dependencies / blockers:** v1 blocked on WebGPU. Both phases benefit from Track 1
(Whisper at fp is too heavy; int8 makes it browser-viable).
**Done when:** v0 — dictation works + file STT via gateway with fallback; v1 — local
Whisper passes the `stt-lab` gate at parity with external STT on a voice-note corpus.

---

### Track 4 — Hono edge API + Docker + Runpod

**Why:** turns liteparse from a library into a product external services call. Highest
commercial value; sharpest technical constraints. **Decided: TS-everywhere** — the GPU
worker is TS + `onnxruntime-node` (+ CUDA EP), Runpod Serverless primary.

**Architecture (two tiers, async between them):**
- **Edge front-door** (Hono + `@hono/zod-openapi` — OpenAPI is near-free since zod is
  already used everywhere; header-token auth). Runs on a CF Worker **or** as the `api`
  container in compose (`@hono/node-server` — same codebase). **No heavy inference
  here** — a CF Worker OOMs on the first real PDF.
- **GPU/CPU worker** (the Docker container): pulls jobs, runs liteparse-core with
  `onnxruntime-node`/CUDA. Same `.onnx` models as the browser, behind the engine interface.

**Tasks**
- [ ] **Async job contract first:** `POST /extract` (or `/transcribe`) → `202 + job_id`
  → `GET /jobs/:id` or webhook. A synchronous edge call can't survive GPU cold-start +
  inference. Design this on day one or rebuild it later.
- [ ] **One Dockerfile → N targets:** `docker-compose` (self-host: Hono `api` +
  TS `worker` + Redis + model volume), Runpod Serverless (same image, GPU, scale-to-zero),
  Fly/Cloud Run/Railway (CPU middle ground). Modal available via `Image.from_dockerfile`
  if its cold-start tooling is ever wanted.
- [ ] **Queue/state infra** (this pulls in the work parked as "separate" in the
  `liteparse-infra-platform-scope` memory): Redis in compose, Upstash + QStash on the
  serverless/edge path. Not optional for async jobs.
- [ ] **Parallelization:** page-level fan-out across N workers, fan-in (queue-backed).
  The real latency win for big docs on the API tier.
- [ ] **Cold-start mitigation:** bake models into the image / mount a volume (cold start
  is model *load*, not download). Decide warm-pool (min-1 always on, costs money, kills
  latency) vs scale-to-zero (cheap, slow first hit) per tier.
- [ ] **Auth at scale:** header token to start, then per-consumer API keys + quotas +
  usage metering. GPU-seconds are expensive — meter or bleed money. Result storage via
  presigned S3/R2 URL or a TTL'd store.
- [ ] **Generalize the router** to decide browser-vs-edge-front-door-vs-container (with
  telemetry on the decision) — the single decision point that keeps the tiers coherent.

**Dependencies / blockers:** benefits from Track 1 (int8 = faster cold start, more
jobs/GPU). Pulls in queue infra.
**Done when:** a clean `docker compose up` runs the full stack locally; one image deploys
to Runpod and serves an async extract job end-to-end; OpenAPI doc is generated and auth works.

---

## Cross-cutting concerns

- **WebGPU is its own line.** int8 (model precision) and WebGPU (execution provider) are
  **orthogonal** — they compose but are separate projects. Track 3 v1 (local Whisper) is
  blocked until the WebGPU backend exists. Do NOT let WebGPU get silently absorbed into
  "int8 work" or Track 3 hits an unstated prerequisite.
- **Telemetry on fallback rates.** Track 2 (VLM fallback by script), Track 3 (external
  STT vs local), Track 4 (tier routing decisions). You can't tune thresholds or justify
  adding models without this. Silent degradation is the failure mode.
- **Model distribution / versioning.** As models multiply (int8 variants, script-keyed
  rec, Whisper), the S3→IndexedDB story needs script/precision/version keys + eviction.
  Tracks 1 & 2 force this plumbing; budget for it inside them.
- **Carry-over from the router's P5 deferrals** (still-open loose ends — fold in or close):
  - edge HTTP dispatch for `location:"edge"` strategies → **folds into Track 4.**
  - forward `strategy.script` to the OCR engine → **folds into Track 2** (per-script rec).
  - engine `dispose()` lifecycle → **repurposed** for Track 3 v1 (Whisper session evict).
  - streaming page render (don't buffer all page images) → still valid, low priority.
  - worker-shell end-to-end integration test → still valid, nice-to-have.
  - confidence-gated cascade descent (low-confidence → Docling) → **CLOSED** (Docling retired).

---

## How to resume

1. Read this file + [ARCHITECTURE.md](./ARCHITECTURE.md).
2. **Start at Track 1** (int8). It's the foundation everything compounds off and has no
   blockers. The truth source for "did int8 break quality?" is `scripts/ocr-lab/calibrate.ts`.
3. Verification gate (unchanged from the router build): `npm run typecheck && npm run test
   && npm run build` must be green before a track is considered done.
4. Studygram-app integration changes (consumer side) happen in the studygram-app repo;
   liteparse-core changes happen here. The Hono API (Track 4) is likely a new `services/`
   dir or sibling — decide its home when Track 4 starts.
5. Relevant memories (studygram-app): `liteparse-roadmap-and-tseverywhere-decision`,
   `ocr-quality-root-causes-and-lab`, `ocr-latency-fixes`, `intelligent-document-router-design`,
   `liteparse-infra-platform-scope`, `agent-vision-routing-live` (the gateway pattern Track 3 reuses).
