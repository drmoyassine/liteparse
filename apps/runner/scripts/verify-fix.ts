/**
 * End-to-end verification of the decode fix through the REAL engine path:
 * createMoonshineServerEngine (wav → wavToModelAudio → decode → tokenizer →
 * stripTashkeel → tokenConfidence) against the stt-lab corpus clips.
 * Standalone diagnostic; run from the liteparse root:
 *   npx -y tsx apps/runner/scripts/verify-fix.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "..", "models", "moonshine");
const CORPUS = resolve(
  HERE, "..", "..", "..", "..",
  "studygram-app", "scripts", "stt-lab", "corpus",
);

const { createMoonshineServerEngine } = await import("../../../dist/stt/moonshine-server.js");

const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf-8")) as Array<{
  file: string;
  language: string;
  transcript: string;
}>;

const engine = await createMoonshineServerEngine({
  debug: false,
  modelPath: MODELS,
});

for (const clip of manifest) {
  const wav = join(CORPUS, clip.file);
  if (!existsSync(wav)) {
    console.log(`skip ${clip.file} (missing)`);
    continue;
  }
  const t0 = Date.now();
  const r = await engine.transcribe(new Uint8Array(readFileSync(wav)), {
    language: clip.language as "en" | "ar",
  });
  const ms = Date.now() - t0;
  console.log(`\n── ${clip.file} (${clip.language}) — ${ms}ms, conf=${r.confidence.toFixed(3)}`);
  console.log(`   got   : ${r.text}`);
  console.log(`   ref   : ${clip.transcript}`);

  // EN slot-2 escalation model (batch-base-en) — was deaf pre-fix; forced here.
  if (clip.language === "en") {
    const t1 = Date.now();
    const esc = await engine.transcribe(new Uint8Array(readFileSync(wav)), {
      language: "en",
      model: "moonshine-batch-base-en",
    });
    console.log(`   slot2 : (base-en forced) ${Date.now() - t1}ms, conf=${esc.confidence.toFixed(3)}`);
    console.log(`   got   : ${esc.text}`);
  }
}

console.log("\nverify-fix done");
