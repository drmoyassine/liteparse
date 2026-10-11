import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { RunnerConfig } from "./config.js";

/**
 * LibreOffice fallback (runner only). liteparse reads office files directly in pure
 * JS; this converter is used only when that read fails, under-yields, looks corrupted,
 * or the file is mostly pictures. The office file becomes a PDF that re-enters the
 * per-page cascade, so embedded pictures are read by the existing RapidOCR engine.
 *
 * Modes (LIBREOFFICE_MODE):
 *  - off          → never convert (callers get a `libreoffice_unavailable` warning)
 *  - lazy         → download a pinned archive (LIBREOFFICE_ARCHIVE_URL + _SHA256) on first
 *                   use, verify, unpack into LIBREOFFICE_CACHE_DIR (persistent disk), reuse
 *  - preinstalled → use LIBREOFFICE_BIN or `soffice` on PATH
 *
 * Conversions run one at a time (a conversion needs ~1–2 GB of memory).
 */
export type PdfConverter = (bytes: Uint8Array, filename: string | undefined, signal?: AbortSignal) => Promise<Uint8Array | null>;

const CONVERT_TIMEOUT_MS = 180_000;

function run(bin: string, args: string[], signal?: AbortSignal, timeoutMs = CONVERT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}

async function findSoffice(dir: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === "soffice" && dir.endsWith("program")) return p;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if ((await stat(p).catch(() => null))?.isDirectory()) {
      const hit = await findSoffice(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function installLazy(cfg: RunnerConfig["libreoffice"]): Promise<string | null> {
  const installDir = join(cfg.cacheDir, "install");
  const cached = await findSoffice(installDir);
  if (cached) return cached;
  if (!cfg.archiveUrl || !cfg.archiveSha256) {
    console.warn("[libreoffice] lazy mode needs LIBREOFFICE_ARCHIVE_URL and LIBREOFFICE_ARCHIVE_SHA256 — fallback disabled");
    return null;
  }
  const t0 = Date.now();
  console.log(`[libreoffice] first use — downloading ${cfg.archiveUrl}`);
  const res = await fetch(cfg.archiveUrl);
  if (!res.ok) throw new Error(`libreoffice archive HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== cfg.archiveSha256) throw new Error(`libreoffice archive sha256 ${sha} != pinned ${cfg.archiveSha256}`);
  await mkdir(cfg.cacheDir, { recursive: true });
  const staging = await mkdtemp(join(cfg.cacheDir, "staging-"));
  const archive = join(staging, "lo.tar");
  await writeFile(archive, buf);
  await run("tar", ["-xf", archive, "-C", staging], undefined, 600_000);
  await rm(archive, { force: true });
  await rm(installDir, { recursive: true, force: true });
  await rename(staging, installDir);
  const bin = await findSoffice(installDir);
  console.log(`[libreoffice] installed in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${bin ?? "soffice NOT FOUND"}`);
  return bin;
}

export function createLibreOfficeConverter(cfg: RunnerConfig["libreoffice"]): PdfConverter {
  if (cfg.mode === "off") return async () => null;
  let binP: Promise<string | null> | null = null;
  const resolveBin = (): Promise<string | null> => {
    binP ??= (cfg.mode === "preinstalled" ? Promise.resolve(cfg.bin ?? "soffice") : installLazy(cfg)).catch((err: unknown) => {
      console.warn("[libreoffice] install failed:", err instanceof Error ? err.message : err);
      binP = null; // retry on the next file
      return null;
    });
    return binP;
  };
  let queue: Promise<unknown> = Promise.resolve();

  return (bytes, filename, signal) => {
    const job = queue.then(async () => {
      const bin = await resolveBin();
      if (!bin) return null;
      const dir = await mkdtemp(join(tmpdir(), "lo-"));
      try {
        const ext = extname(filename ?? "") || ".bin";
        const input = join(dir, `input${ext}`);
        await writeFile(input, bytes);
        await run(bin, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, input], signal);
        const out = join(dir, "input.pdf");
        // null means "unavailable"; a conversion that produced nothing is an error.
        if (!existsSync(out)) throw new Error("LibreOffice produced no PDF (unreadable or damaged file)");
        return new Uint8Array(await readFile(out));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    queue = job.catch(() => undefined);
    return job;
  };
}
