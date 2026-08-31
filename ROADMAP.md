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
   *(STT model updated 2026-09-01: the self-host STT family is Moonshine EN/AR, not
   Whisper — see Track 3.)*

**Honest ceiling this accepts:** *(STT half superseded 2026-09-01 — the self-host STT
family is now Moonshine, not Whisper; see Track 3.)* Whisper via `onnxruntime-node` is
good, not best (no `faster-whisper`). Fine for voice-note clips; bulk long-form would
use the external STT fallback. OCR is first-class on every tier.

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

### Track 3 — litecomposer (speech) · **REVISED 2026-09-01**

**Why:** turns liteparse from doc→text into media→text. The architecture (worker,
ModelOrigin, IndexedDB cache, router) maps directly onto audio.

**The revision, in one paragraph:** the old plan (Web Speech dictation now, in-browser
Whisper v1 blocked on WebGPU) is superseded. The WebGPU blocker was stale (real-time
browser Whisper on WebGPU has existed since 2024), but more decisively: the **Moonshine
family** ([moonshine-ai](https://huggingface.co/moonshine-ai)) fits both hard product
constraints — **latency** and **Arabic/English** — better than Whisper at every tier:

- **Per-language models at edge sizes.** `moonshine-streaming-tiny-ar` (27M, MIT):
  CV-Arabic 17.9 / FLEURS-Arabic 12.6 WER — ≈ Whisper-medium (769M) territory at
  1/28th the params. Whisper-tiny is *unusable* on Arabic (WER 66–89); browser-sized
  Whisper was never going to carry Arabic. (Checkpoint ships PyTorch-only — the AR
  *local* slot runs the batch tiny-ar ONNX export instead; see Artifact status.)
- **CPU-first streaming architecture.** Streaming encoder (~80ms lookahead, 50Hz
  causal frontend) + no Whisper-style 30s zero-padding — compute scales with actual
  audio length (≈5× less compute on a 10s clip than same-size Whisper). Designed for
  0.1–1 TOPS / <1GB → **v1 local tier needs no WebGPU**: plain WASM covers Firefox,
  Safari, old Android. No capability cliff.
- **Local-runnable models for both EN and AR** (EN streaming `.ort`, AR batch int8 —
  both verified loadable in ort-node *and* ort-web/wasm by the 2026-09-01 spike) →
  the same-models-every-tier rule holds.

**The cascade (mirrors the OCR one):**

| Tier | Models | Role |
|---|---|---|
| Browser (WASM worker) | EN `moonshine-streaming-tiny` `.ort`; AR **batch** `tiny-ar` int8 ONNX | live dictation + clips, both langs |
| `apps/runner` slot 1 | same two models (EN streaming `.ort`, AR batch int8) | browser parity for server-originated audio |
| `apps/runner` slot 2 | `moonshine-base` ONNX EN (MIT) | strictly-stronger escalation (EN only) |
| External gateway | `gpt-4o-transcribe` via `SttGateway` | quality ceiling, confidence-gated — the AR escalation path |

**Code-switching:** AR's local model is batch `moonshine-tiny-ar` — the variant trained
*with* code-switching — precisely because the streaming-AR checkpoint has no ONNX
export. Mixed AR/EN quality is therefore a property of the model we already run;
`stt-lab` measures it rather than gating an optional extra.

**Artifact status (verified 2026-09-01; spike run 2026-09-01 —
`apps/runner/scripts/spike-moonshine.mjs`, all experiments passing):**
- **EN streaming `.ort`** (`moonshine-ai/moonshine-streaming` `onnx/tiny/`, MIT ✅):
  five-graph set — frontend 7.9 MB · encoder 7.2 · decoder_kv 90.9 · cross_kv 1.2 ·
  adapter 5.0 (≈112 MB fp32; the parallel `decoder.ort` 92 MB is an either/or with
  decoder_kv+cross_kv). Loads from **buffer and path in onnxruntime-node 1.29, and
  from bytes in onnxruntime-web/wasm 1.27 under Node** (Phase C viable, official
  artifacts, no fallback needed). Chain verified end-to-end minus the decode step:
  `audio_chunk float32[1,1600]` + 5 zero state inputs (`sample_buffer[1,79]`,
  `sample_len[1]` int64, `conv1_buffer[1,320,4]`, `conv2_buffer[1,640,4]`,
  `frame_count[1]` int64) → `features[1,5,320]` (50 Hz) → `encoded[1,5,320]` →
  adapter(+`pos_offset`) → `memory[1,5,320]` → cross_kv → `k/v_cross[6,1,8,·,40]`
  (6 layers × 8 heads × head_dim 40). Decoder exposes **`logits`** + self/cross KV
  state outputs — per-token logprob confidence works as designed. Config:
  `streaming_config.json` (frame_len 80, lookahead 16, vocab 32 768, bos 1 / eos 2).
- **AR batch int8 ONNX** (`onnx-community/moonshine-tiny-ar-ONNX`, license **"other"**
  ⚠): encoder 7.6 MB + decoder_model_merged 19.4 (≈27 MB). Encoder input is
  **`input_values` = raw 16 kHz waveform** — the ConvFrontend is baked into the
  encoder, so *no mel frontend is needed anywhere* (the feared `shared/audio.ts`
  fallback is dead). `last_hidden_state[1,40,288]` for 1 s of audio. Decoder is the
  standard transformers.js merged export: `input_ids`, `encoder_hidden_states`,
  `past_key_values.{0-5}.{decoder,encoder}.{key,value}`, `use_cache_branch` →
  **`logits`** + `present.*`. Classic `.onnx` loads from bytes in BOTH runtimes.
  **Cache-branch quirk (probed 2026-09-01, real-model smoke):** with
  `use_cache_branch=1` the export emits **broken encoder-KV presents**
  (`[0,8,1,36]`, dim 0 zeroed); feeding one back fails encoder_attn's MatMul on the
  next step. That branch recomputes cross-KV from `encoder_hidden_states` each
  step, so the decoder loop must keep the encoder past **empty** and thread only
  the decoder self-KV (`present.{l}.decoder.*`). Encoded once in
  `src/stt/moonshine-server.ts` `decodeBatch`; the Phase C browser engine reuses
  the same loop and inherits the fix.
- **Streaming-AR**: checkpoint exists (MIT) but **no ONNX export anywhere** — the
  cascade's AR legs run batch tiny-ar. If streaming-AR ONNX ever appears (official
  export or ours), it can slot in without architecture changes.
- **`onnx-community/moonshine-base-ONNX` EN** = **MIT** ✅ (fp32/fp16/int8/uint8/q4
  full matrix) — slot 2's license question is closed. `moonshine-base-ar-ONNX` exists
  but looks like a placeholder (0 downloads, no pipeline tags) — ignored; AR
  escalates straight to the external gateway past slot 1.
- **Licenses:** streaming EN `.ort` + base EN = MIT ✅ (bake freely). `tiny-ar` =
  "other" ⚠ — never redistributed via npm (fetch script + HF browser download, same
  as PP-OCR today); resolve the actual license text before any *public* Docker
  distribution. Internal runner bake is use, not redistribution.
- Arabic quality: card benchmarks only (MSA-heavy corpora). Dialect (Gulf first),
  real-mic conditions, and mixed speech are **unmeasured** → that is `stt-lab`'s job.

**v0 — external gateway first (no model, no worker):**
- [x] `SttGateway` interface mirroring `VlmGateway` + OpenAI-compatible
      `/v1/audio/transcriptions` implementation (`gpt-4o-transcribe`; same gateway
      account pattern as the VLM: `parse_vlm_account_id` → `stt_account_id`).
      *(Shipped 2026-09-01, Phase A: `src/stt/gateway.server.ts` via `liteparse/stt/server`;
      `parseDocument()` accepts audio as a first-class kind, `sniff` detects WAV/MP3/Ogg/
      FLAC/M4A, the route degrades to best-effort text when no gateway is wired.)*
- [x] Graceful "gateway absent" → user types. (Web Speech API dictation: **dropped** —
      vendor-cloud, single `lang` tag per session, no code-switching, no Firefox.
      Superseded by v1 local streaming, which does the job locally in both languages.)

**v0.5 — runner `/transcribe`:**
- [x] `POST /transcribe` on `apps/runner` (same container/auth/model-pinning pattern):
      slot 1 = streaming-tiny EN `.ort` + batch tiny-ar int8 (parity with browser),
      slot 2 = base EN, then pass-through escalation to the caller's `SttGateway`.
      Arabic audio stays in our infra; kills per-call API cost on the happy path.
      *(Shipped 2026-09-01, Phases B.1–B.3: shared-core + `moonshine-server` engine via
      `liteparse/stt/moonshine-server`; runner `stt-service.ts` walk (WAV pre-flight →
      slot1 → en:slot2 → gateway → best-effort), `/transcribe` sharing `/parse`'s
      semaphore + auth, `stt:ready` health flag, sha256-pinned models in the Dockerfile
      (~199 MB), tokenizer/config sidecars committed. Live-verified: EN sine walks both
      slots → best-effort with honest warnings; AR sine resolves at slot 1 conf 0.869 —
      the hallucination-on-silence case `stt-lab` must flag.)*

**v1a — browser local, clips (WASM, no WebGPU dependency):**
- [x] Local decode in the existing model plumbing (ModelOrigin → IndexedDB read-through,
      warm singleton) — the batch/streaming decode loops extracted to
      `engines/moonshine/shared/decode.ts` so browser (`onnxruntime-web/wasm`) and runner
      (`onnxruntime-node`) run the IDENTICAL loop (the batch encoder-KV cache-branch fix
      lives once, for both). *(Shipped 2026-09-01, Phase C: `liteparse/engines/moonshine` +
      `setBrowserSttEngine(createMoonshineSttEngine({ modelOrigin: createMoonshineModelOrigin() }))`;
      binaries from HF `/resolve/`, tokenizer/streaming-config JSONs served same-origin
      (dict precedent — decode tables must not mutate under a cached binary); non-WAV
      clips decode in-engine via `AudioContext.decodeAudioData`, so webm/opus/mp3 work
      browser-side without the runner's WAV-only 422.)*
- [x] **STT confidence gate**: decoder per-token logprobs (autoregressive decode) →
      length-weighted geometric mean (`shared/confidence.ts`, floor 0.55 — NOT OCR's
      0.85; different measurement, different scale). Engine-side in the browser
      (`text non-empty && conf < floor` → `{text:""}` → route under-yield → external
      gateway leg); service-side in the runner (its stronger legs are local).
      Thresholds calibrated per **model × language** in `stt-lab` —
      `MODEL_STT_CONFIDENCE_FLOORS` is the seam. *(Shipped 2026-09-01, Phases B.2/C.)*
- [x] Engine dispose/LRU (the deferred lifecycle work): `maxLoadedModels` (default 2 =
      EN streaming + AR batch ≈ 139 MB) with least-recently-used disposal; inflight
      loads deduped. *(Shipped 2026-09-01, Phase C.)*
- [x] Diacritics policy decided once, in the engine (default: strip tashkeel;
      `keepDiacritics` to keep) — `shared/tokens.ts`; stt-lab validates output quality
      against it. *(Shipped 2026-09-01, Phase B.2.)*
- [x] stt-lab debug line (repo-side deliverable): one flat record per transcribe —
      model, lang, audio_s, decode_s, rtf, tokens, mean/min token prob, top-5 worst
      tokens, silence-hallucination + repetition-loop flags, diacritics stripped/kept
      (`shared/stats.ts` `sttDebugLine`; debug-gated like OCR telemetry).
      *(Shipped 2026-09-01, Phases B.2/C.)*

**v1b — browser local, live dictation (streaming):** the D1/D2 split from the plan —
D1 (VAD-chunked batch) shipped; D2 (true incremental decode) remains gated on a live spike.

- [x] Dictation protocol, deliberately separate from the parse worker protocol
      (long-lived bidirectional chunk stream with recurring interims vs
      request/response + single terminal ResultEvent):
      `src/stt/streaming/protocol.ts` — start/chunk/stop → ready/interim/final/
      error/stopped + guards. *(Shipped 2026-09-01, Phase D.)*
- [x] RMS utterance segmentation (pure, no ML): `src/stt/streaming/segmentation.ts` —
      speech threshold + 480 ms hangover close, 240 ms blip filter measured on SPEECH
      content (the quiet tail can't rescue a click), 160 ms pre-roll, 15 s force-final,
      flush-on-stop keeps short finals. *(Shipped 2026-09-01, Phase D.)*
- [x] Capture worklet (`liteparse/stt/worklet`, zero-import): mono mixdown + exact
      100 ms frames at the CONTEXT rate — no resample in the worklet (the
      quality-critical sinc resampler lives in testable `shared/audio.ts`; linear
      downsampling in the worklet would alias speech energy above 8 kHz back into
      band on 44.1/48 kHz contexts). *(Shipped 2026-09-01, Phase D.)*
- [x] Dictation worker (`liteparse/stt/dictation-worker`, self-installing, never
      imports ocr-worker): resample → segment → transcribe each finalized utterance
      through the Phase-C Moonshine engine (fed WAV bytes — reuses the engine's whole
      gate + telemetry path unchanged); finals serialized in utterance order;
      throttled trailing-buffer interims (first at 900 ms, ≥1.2 s apart, one in
      flight, superseded previews dropped on arrival); stop flushes and posts
      `stopped` only after the queue drains. *(Shipped 2026-09-01, Phase D.)*
- [x] Main-thread client (`liteparse/stt/dictation`, `createDictation`): owns
      AudioContext + `addModule` + the frame relay (buffer transferred); mic via
      deviceId (tracks released on stop) or injected MediaStream (caller keeps the
      tracks); 10 s ready / 30 s stop timeouts; unwind on failed start.
      *(Shipped 2026-09-01, Phase D.)*
- [ ] D2 — true incremental decode (`src/stt/streaming/incremental-decoder.ts`,
      200 ms frontend buffer + 80 ms lookahead, stateful encoder, stepped decoder;
      TTFT target 0.3–0.6 s). **Entry criterion: a live spike of chunked
      state-threading semantics against the real `.ort` graphs** — the B.1 spike
      verified loadability and I/O shapes, never the chunked loop; hermetic mocks
      cannot catch graph-level quirks (the encoder-KV cache-branch bug is the
      precedent). D1's re-decode-partial is correct, just not incremental, so v1b
      ships without D2.

**`stt-lab` — build with v0, gate v1 (the `ocr-lab` analog; lives beside it in
studygram-app):**
- [ ] Seed corpus: ~10 Arabic clips (MSA **and** Gulf dialect), ~5 mixed AR/EN, ~5 EN.
- [ ] Run streaming-tiny EN `.ort` + batch tiny-ar int8 + base EN + `gpt-4o-transcribe`;
      record quality (human-scored WER), TTFT, clip real-time factor,
      hallucination-on-silence rate, and diacritics behavior.
- [ ] Decides: the code-switching add, the AR escalation slot (base-ar vs
      straight-to-external), confidence floors per model×language.

**Latency budget (estimates; `stt-lab` replaces them with measurements):**

| Path | Estimate | Basis |
|---|---|---|
| Browser cold start (EN streaming `.ort` 112MB fp32 + AR batch int8 27MB) | ~139MB download + 1–3s session init; warm ~0.5–2s | measured artifact sizes (spike); preload on mic-intent. Int8 `.ort` conversions (sherpa-onnx) or batch-EN-int8 for the clips path are the levers if 139MB proves too heavy |
| Live TTFT, local streaming | **~0.3–0.6s** (no network) | 200ms frontend buffer + 80ms lookahead + decode step; vendor C++ claims <200ms |
| 10s note, browser WASM | ~1–4s | ≈5× less compute than whisper-tiny (no 30s padding); whisper-tiny WASM ≈ real-time |
| 10s note, runner slot 1 | ~0.5–2s e2e | upload (opus ~100KB) + native-CPU inference (~2–4× WASM) |
| 10s note, runner slot 2 (base) | ~1–3s e2e | 1.6× tiny FLOPs |
| 10s note, external | ~2–5s typical, p95 higher | upload-bandwidth-bound + 1–3s inference; community-reported tail instability |
| Full escalation (local→runner→external) | ~4–10s | why the confidence gate must escalate *rarely* |

**Measured on the dev box (2026-09-01, live `/transcribe`, warm slot 1):** EN
streaming 1.2 s clip → **1.0 s** decode (RTF ≈ 0.85, immediate EOS on sine); EN
full walk (slot 1 empty → base-en load 2.3 s + decode 2.5 s) → 2.5 s e2e; AR batch
1.0 s clip → 5.2 s first call (1.9 s load + 194-token no-EOS worst case ≈ 3.4×
real-time), i.e. the estimates above hold for EN and are optimistic for AR's
degenerate loop — `stt-lab` clips replace sine with speech (EOS arrives in
tens of tokens).

**Dependencies / blockers:** none architectural — the 2026-09-01 spike resolved the
`.ort` loadability question in **both** runtimes (all green) and the base-EN license
(MIT), and the B.2 decoder probes + real-model smoke resolved every decode-loop
shape question (streaming self-KV `[6,1,8,0,40]`, batch past `[1,8,0,36]`, and the
cache-branch encoder-KV quirk above — both families now transcribe real audio
end-to-end). Remaining gates: the `tiny-ar` "other" license text (before any *public*
image distribution — internal bake and npm-free fetching are fine) and `stt-lab`'s
dialect verdict. Track 1 (int8) is mostly free on the
AR/batch side (int8 exports exist); EN streaming `.ort` ships fp32 — int8 conversions
are a size optimization, not a blocker.
**Done when:** v0 — file STT via gateway with graceful degradation; v0.5 — runner serves
`/transcribe` at parity with the browser path; v1 — local streaming passes the
`stt-lab` gate at parity with external STT on the seed corpus, both languages, no
WebGPU requirement.

---

### Track 4 — Hono edge API + Docker + Runpod

**Status — v1 synchronous slice SHIPPED (`apps/runner`, 2026-08):** a single-container
Hono service (`@hono/node-server`, header-token auth, `POST /parse` mirroring studygram's
`parse-document` contract) running liteparse-core with the SAME PP-OCRv4 models as the
browser on `onnxruntime-node`, models baked into the image at sha256-pinned URLs. It
exists to give server-side parses browser parity (raster + local OCR before VLM) —
deployed on the existing Easypanel VPS via `apps/runner/Dockerfile`. The tasks below
(async job contract, queue/state infra, page-level fan-out, quotas/metering) are the
multi-tenant product shape this v1 deliberately defers; v1 serves one trusted caller
(studygram edge functions) synchronously.

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
  **orthogonal** — they compose but are separate projects. *(Updated 2026-09-01: Track 3
  v1 no longer depends on WebGPU — Moonshine's local tier is WASM-first. WebGPU remains
  its own line for the Granite-Docling browser tier and as optional STT acceleration.)*
  Do NOT let WebGPU get silently absorbed into "int8 work" or another track hits an
  unstated prerequisite.
- **Telemetry on fallback rates.** Track 2 (VLM fallback by script), Track 3 (external
  STT vs local), Track 4 (tier routing decisions). You can't tune thresholds or justify
  adding models without this. Silent degradation is the failure mode.
- **Model distribution / versioning.** As models multiply (int8 variants, script-keyed
  rec, Whisper), the S3→IndexedDB story needs script/precision/version keys + eviction.
  Tracks 1 & 2 force this plumbing; budget for it inside them.
- **Carry-over from the router's P5 deferrals** (still-open loose ends — fold in or close):
  - edge HTTP dispatch for `location:"edge"` strategies → **folds into Track 4.**
  - forward `strategy.script` to the OCR engine → **folds into Track 2** (per-script rec).
  - engine `dispose()` lifecycle → **repurposed** for Track 3 v1 (STT session evict).
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
