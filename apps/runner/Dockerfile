# syntax=docker/dockerfile:1
#
# Parse runner — the self-hosted counterpart to liteparse's browser runtime
# (DEC-083 / studygram's DEC-082 follow-up). Build context = REPO ROOT:
#   docker build -f apps/runner/Dockerfile -t liteparse-runner .
#
# Why the npm-pack dance in the build stage: apps/runner declares
# "liteparse": "file:../..", which npm materializes as a SYMLINK to the repo
# root — Node then resolves liteparse's own imports from the realpath, so at
# runtime the container would need the root's node_modules too. Installing the
# packed tarball instead gives a REAL copy under apps/runner/node_modules with
# every dependency hoisted next to it; the runtime stage ships exactly that
# tree and nothing else.
#
# All native deps (sharp, @napi-rs/canvas, canvas, onnxruntime-node) ship
# prebuilt Linux x64 binaries — no apt-get in any stage.

# ── Stage 1: fetch + verify the PP-OCRv4 models ────────────────────────────────
# Pins must match scripts/fetch-rapidocr-models.mjs (which prints them). The
# det URL is NOT the one the browser uses — its original mirror went 401
# upstream (2026-08); see src/engines/rapidocr/model-origin-hf.ts for history.
FROM node:22-slim AS models
WORKDIR /models
COPY apps/runner/models/ppocr-en-dict.txt /models/rapidocr/ppocr-en-dict.txt
RUN <<'EOF'
set -eux
# Det: breezedeus/cnstd conversion of the official ch_PP-OCRv4 mobile det weights
curl -fsSL -o /models/rapidocr/ch_PP-OCRv4_det_infer.onnx \
  "https://huggingface.co/breezedeus/cnstd-ppocr-ch_PP-OCRv4_det/resolve/main/ch_PP-OCRv4_det_infer.onnx"
# Rec: breezedeus/cnocr English PP-OCRv4 rec weights
curl -fsSL -o /models/rapidocr/en_PP-OCRv4_rec_infer.onnx \
  "https://huggingface.co/breezedeus/cnocr-ppocr-en_PP-OCRv4/resolve/main/en_PP-OCRv4_rec_infer.onnx"
cd /models/rapidocr
echo "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9  ch_PP-OCRv4_det_infer.onnx" | sha256sum -c -
echo "5ca59a096cf493d5fd5044b9ccc1bdea9229fbcf656bd76040ff80a00201ee16  en_PP-OCRv4_rec_infer.onnx" | sha256sum -c -
EOF

# ── Stage 2: build the library + the runner ───────────────────────────────────
FROM node:22-slim AS build
WORKDIR /repo
# Root first for a deterministic install layer. The committed package-lock.json
# carries a stray `vite_react_shadcn_ts` link (a known local-tooling accident),
# so drop it and resolve fresh — same as studygram's Dockerfile Stage 0.
COPY package.json ./
RUN rm -f package-lock.json && npm install --no-audit --no-fund
COPY tsup.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm pack --pack-destination /tmp

WORKDIR /repo/apps/runner
COPY apps/runner/package.json apps/runner/tsconfig.json apps/runner/tsup.config.ts ./
COPY apps/runner/src ./src
COPY apps/runner/scripts ./scripts
RUN <<'EOF'
set -eux
npm install --no-audit --no-fund
# Replace the file:../.. symlink with a REAL copy from the tarball (see header).
npm install --no-save /tmp/liteparse-*.tgz
npm run build
EOF

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    RAPIDOCR_MODEL_PATH=/app/models/rapidocr
# Only the runner's own tree: dist + node_modules (natives + tarball-installed
# liteparse, all Linux binaries from this build) + manifest + models.
COPY --from=build /repo/apps/runner/dist ./dist
COPY --from=build /repo/apps/runner/node_modules ./node_modules
COPY --from=build /repo/apps/runner/package.json ./package.json
COPY --from=models /models/rapidocr ./models/rapidocr
EXPOSE 3000
# node:22-slim has no curl/wget — probe with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
