# syntax=docker/dockerfile:1
#
# Parse runner — the self-hosted counterpart to liteparse's browser runtime
# (DEC-083 / studygram's DEC-082 follow-up). Build context = REPO ROOT:
#   docker build -f apps/runner/Dockerfile -t liteparse-runner .
#
# Why the npm-pack dance in the build stage: apps/runner declares
# "@drmoyassine/liteparse": "file:../..", which npm materializes as a SYMLINK to the repo
# root — Node then resolves liteparse's own imports from the realpath, so at
# runtime the container would need the root's node_modules too. Installing the
# packed tarball instead gives a REAL copy under apps/runner/node_modules with
# every dependency hoisted next to it; the runtime stage ships exactly that
# tree and nothing else.
#
# All native deps (sharp, @napi-rs/canvas, canvas, onnxruntime-node) ship
# prebuilt Linux x64 binaries — no apt-get in any stage.

# ── Stage 1: fetch + verify the OCR + STT models ──────────────────────────────
# Pins must match scripts/fetch-rapidocr-models.mjs and
# scripts/fetch-moonshine-models.mjs (which print them). The OCR det URL is NOT
# the one the browser uses — its original mirror went 401 upstream (2026-08);
# see src/engines/rapidocr/model-origin-hf.ts for history. Moonshine licenses:
# streaming EN, streaming AR (official Useful Sensors artifacts, fetched from
# our byte-identical HF mirror), and base EN are all MIT; AR batch is license
# "other" (fetch/bake OK,
# never npm-redistribute — noted in src/engines/moonshine/shared/models.ts).
# Download via node itself — debian slim ships no curl/wget.
FROM node:22-slim AS models
WORKDIR /models
# Committed text sidecars (dict + tokenizer/streaming-config JSONs) ride the
# build context; only the binaries are downloaded + hash-verified.
COPY apps/runner/models/ppocr-en-dict.txt /models/rapidocr/ppocr-en-dict.txt
COPY apps/runner/models/moonshine /models/moonshine
RUN <<'EOF'
set -eux
node <<'NODE'
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const ARTIFACTS = [
  // ── PP-OCRv4 (rapidocr) ──
  // Det: breezedeus/cnstd conversion of the official ch_PP-OCRv4 mobile det weights
  ["rapidocr", "ch_PP-OCRv4_det_infer.onnx",
   "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
   "https://huggingface.co/breezedeus/cnstd-ppocr-ch_PP-OCRv4_det/resolve/main/ch_PP-OCRv4_det_infer.onnx"],
  // Rec: breezedeus/cnocr English PP-OCRv4 rec weights
  ["rapidocr", "en_PP-OCRv4_rec_infer.onnx",
   "5ca59a096cf493d5fd5044b9ccc1bdea9229fbcf656bd76040ff80a00201ee16",
   "https://huggingface.co/breezedeus/cnocr-ppocr-en_PP-OCRv4/resolve/main/en_PP-OCRv4_rec_infer.onnx"],
  // ── Moonshine streaming tiny EN (slot 1) — moonshine-ai, MIT ──
  ["moonshine/streaming-tiny-en", "frontend.ort",
   "2257542ce88f8ce00dfce8431e654045ba8e8e64d40bb941b0bdb92a0aaf31ec",
   "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/frontend.ort"],
  ["moonshine/streaming-tiny-en", "encoder.ort",
   "9284a8146b0819ca609e6c66a2d8a92a52029a489825b3f678197a3c1adbd18f",
   "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/encoder.ort"],
  ["moonshine/streaming-tiny-en", "adapter.ort",
   "9ef4731ef99ebf065760f3131b0e61cd8eeecc247ef4c2361bd663c3bfbda267",
   "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/adapter.ort"],
  ["moonshine/streaming-tiny-en", "cross_kv.ort",
   "9f43346bf9cab98642e23286f7f1ad105676c9fdd960a1bb969a93ace7227d4e",
   "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/cross_kv.ort"],
  ["moonshine/streaming-tiny-en", "decoder_kv.ort",
   "b263a0be74f74d5279b6087a9663d9220d0304de35b13ad981ac89f7aaa653e9",
   "https://huggingface.co/moonshine-ai/moonshine-streaming/resolve/main/onnx/tiny/decoder_kv.ort"],
  // ── Moonshine streaming tiny AR (slot 1) — OFFICIAL Useful Sensors artifacts
  //    (quantized_26_08_24), fetched from our byte-identical HF mirror (the
  //    official CDN sends no CORS headers; MIT — the streaming family is MIT
  //    per the upstream LICENSE, verified 2026-09-03). The six sha256 pins are
  //    the original CDN files': decodes long clips cleanly where every
  //    HF-checkpoint export looped past ~2 s (spike 2026-09-02). Frontend
  //    ships as graph + weights pair (bindFrontendWeights). ──
  ["moonshine/streaming-tiny-ar", "frontend.model.ort",
   "04c552e66efe3f7206d0a69779864f93bf3cfaf2fa595c9ce5101c8e3854a414",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/frontend.model.ort",
   20_000],
  ["moonshine/streaming-tiny-ar", "frontend.weights.ort",
   "6cc4d70efffe757452996574d11065e7dac6a7ff0a9be3e2fec1d0266b062b0e",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/frontend.weights.ort"],
  ["moonshine/streaming-tiny-ar", "encoder.ort",
   "6785ca9932d59265375249a8f3bc62f8333fb4dee6ab7db8dfd6f1daef66f59e",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/encoder.ort"],
  ["moonshine/streaming-tiny-ar", "adapter.ort",
   "9c1278a338b4ff268fc5741be01446d56ca9cba9ff5f4a75c5e1b2c2e2739361",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/adapter.ort"],
  ["moonshine/streaming-tiny-ar", "cross_kv.ort",
   "e317af289233894f49da429d4561150c2f61ca86c1b9ca91c6edd3fb4fdeecb5",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/cross_kv.ort"],
  ["moonshine/streaming-tiny-ar", "decoder_kv.ort",
   "5c9a2bf2d9fc543fd4596b3ab4ab8d09f791aac5682eb1379fd8d59e34237db0",
   "https://huggingface.co/Drmoyassine/moonshine-streaming-tiny-ar-ort/resolve/main/decoder_kv.ort"],
  // ── Moonshine tiny AR int8 (explicit-choice fallback, batch family)
  //    — onnx-community, license "other" ──
  ["moonshine/batch-tiny-ar", "encoder_model_int8.onnx",
   "189c63a96dbedcbce32987ccb2ef52367b5392744fdc9b05f3d5442b0db4e85f",
   "https://huggingface.co/onnx-community/moonshine-tiny-ar-ONNX/resolve/main/onnx/encoder_model_int8.onnx"],
  ["moonshine/batch-tiny-ar", "decoder_model_merged_int8.onnx",
   "c3d7481beb40f0880155195a12c619e035fd67249b8d0315d90f7f32dca4d380",
   "https://huggingface.co/onnx-community/moonshine-tiny-ar-ONNX/resolve/main/onnx/decoder_model_merged_int8.onnx"],
  // ── Moonshine base EN int8 (slot 2) — onnx-community, MIT ──
  ["moonshine/batch-base-en", "encoder_model_int8.onnx",
   "4edb38db96b52ddee5a3b25d2211bb6394f9a9a2d95f67bce0e8c861da018a4d",
   "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model_int8.onnx"],
  ["moonshine/batch-base-en", "decoder_model_merged_int8.onnx",
   "45febab0347ffbe1326459e092ae20a2cfda10ca33ab018b3c299247284de61b",
   "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/decoder_model_merged_int8.onnx"],
];
(async () => {
  for (const [dir, name, sha256, url, minBytes = 500_000] of ARTIFACTS) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Early clear error on an error-page body; the sha256 pin below is the
    // real integrity check (minBytes has one override: the AR frontend GRAPH
    // is legitimately 23 KB — its weights ship next to it).
    if (buf.length < minBytes) throw new Error(`${name}: suspiciously small (${buf.length}B)`);
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`${name}: sha256 ${got} != ${sha256}`);
    writeFileSync(`/models/${dir}/${name}`, buf);
    console.log(`verified ${dir}/${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
NODE
EOF

# ── Stage 2: build the library + the runner ───────────────────────────────────
FROM node:22-slim AS build
WORKDIR /repo
# Root first for a deterministic install layer. The committed package-lock.json
# carries a stray `vite_react_shadcn_ts` link (a known local-tooling accident),
# so drop it and resolve fresh — same as studygram's Dockerfile Stage 0.
# scripts/ must precede npm install: the postinstall (copy-ort-wasm →
# copy-pdfjs-worker) runs DURING install and needs those files — locally they
# always sit next to package.json, a fresh checkout does not have them yet.
COPY package.json ./
COPY scripts ./scripts
RUN rm -f package-lock.json && npm install --no-audit --no-fund
COPY tsup.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build && npm pack --pack-destination /tmp

WORKDIR /repo/apps/runner
COPY apps/runner/package.json apps/runner/tsconfig.json apps/runner/tsup.config.ts ./
COPY apps/runner/src ./src
COPY apps/runner/scripts ./scripts
RUN <<'EOF'
set -eux
npm install --no-audit --no-fund
# Replace the file:../.. symlink with a REAL copy from the tarball (see header).
npm install --no-save /tmp/drmoyassine-liteparse-*.tgz
npm run build
EOF

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
# The Moonshine set is ~231 MB (streaming EN fp32 .ort + streaming AR official
# int8 .ort + AR/base batch int8 .onnx) on top of PP-OCR's ~15 MB — cold start
# pays session LOAD, not download.
ENV NODE_ENV=production \
    PORT=3000 \
    RAPIDOCR_MODEL_PATH=/app/models/rapidocr \
    MOONSHINE_MODEL_PATH=/app/models/moonshine
# Only the runner's own tree: dist + node_modules (natives + tarball-installed
# liteparse, all Linux binaries from this build) + manifest + models.
COPY --from=build /repo/apps/runner/dist ./dist
COPY --from=build /repo/apps/runner/node_modules ./node_modules
COPY --from=build /repo/apps/runner/package.json ./package.json
COPY --from=models /models/rapidocr ./models/rapidocr
COPY --from=models /models/moonshine ./models/moonshine
EXPOSE 3000
# node:22-slim has no curl/wget — probe with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
