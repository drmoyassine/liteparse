/**
 * Image-format helpers: sniff the concrete raster format, and a small pure-JS TIFF
 * decoder for the browser (browsers can't open TIFF). Supports strips with no
 * compression, PackBits, LZW and Deflate; 1/4/8/16-bit gray, palette, RGB(A); the
 * horizontal predictor. CCITT fax and tiled TIFFs throw (the caller then hands the
 * original bytes to the vision step with a warning).
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "bmp" | "webp" | "tiff";

export function imageFormat(b: Uint8Array): ImageFormat | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  return null;
}

/** Formats every OCR engine reads directly; the rest are converted to PNG first. */
export function needsPngConversion(b: Uint8Array): boolean {
  const f = imageFormat(b);
  return f !== null && f !== "png" && f !== "jpeg";
}

export interface DecodedFrame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

function packBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < src.length; ) {
    const n = (src[i++]! << 24) >> 24;
    if (n >= 0) for (let k = 0; k <= n && i < src.length; k++) out.push(src[i++]!);
    else if (n !== -128) {
      const v = src[i++]!;
      for (let k = 0; k < 1 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

function lzw(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let codeLen = 9;
  let bit = 0;
  const read = (): number => {
    let v = 0;
    for (let k = 0; k < codeLen; k++) {
      const byte = src[bit >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      reset();
      codeLen = 9;
      prev = null;
      continue;
    }
    let entry: number[];
    if (prev === null) {
      entry = dict[code] ?? [];
    } else if (code < dict.length) {
      entry = dict[code]!;
      dict.push(prev.concat(entry[0]!));
    } else {
      entry = prev.concat(prev[0]!);
      dict.push(entry);
    }
    for (const v of entry) out.push(v);
    prev = entry;
    if (dict.length + 1 >= 1 << codeLen && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

async function inflate(src: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream }).DecompressionStream;
  if (!DS) throw new Error("tiff: deflate needs DecompressionStream");
  const stream = new Blob([src as BlobPart]).stream().pipeThrough(new DS("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode every frame (IFD) of a TIFF to RGBA. */
export async function decodeTiff(bytes: Uint8Array): Promise<DecodedFrame[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const frames: DecodedFrame[] = [];
  let ifd = u32(4);
  const seen = new Set<number>();

  while (ifd && ifd + 2 <= bytes.length && !seen.has(ifd) && frames.length < 1000) {
    seen.add(ifd);
    const tags = new Map<number, number[]>();
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = type === 3 ? 2 : type === 4 ? 4 : 1;
      const off = count * size > 4 ? u32(e + 8) : e + 8;
      const vals: number[] = [];
      for (let k = 0; k < count && off + k * size < bytes.length; k++) {
        vals.push(size === 2 ? u16(off + k * 2) : size === 4 ? u32(off + k * 4) : bytes[off + k]!);
      }
      tags.set(tag, vals);
    }
    ifd = u32(ifd + 2 + n * 12);

    const w = tags.get(256)?.[0] ?? 0;
    const h = tags.get(257)?.[0] ?? 0;
    const bps = tags.get(258)?.[0] ?? 1;
    const comp = tags.get(259)?.[0] ?? 1;
    const photo = tags.get(262)?.[0] ?? 1;
    const spp = tags.get(277)?.[0] ?? 1;
    const predictor = tags.get(317)?.[0] ?? 1;
    const offsets = tags.get(273);
    const counts = tags.get(279);
    if (!w || !h) continue;
    if (!offsets || !counts) throw new Error("tiff: tiled or strip-less images are not supported");
    if (![1, 5, 8, 32773, 32946].includes(comp)) throw new Error(`tiff: compression ${comp} not supported`);

    const parts: Uint8Array[] = [];
    for (let s = 0; s < offsets.length; s++) {
      const raw = bytes.subarray(offsets[s]!, offsets[s]! + (counts[s] ?? 0));
      parts.push(comp === 1 ? raw : comp === 5 ? lzw(raw) : comp === 32773 ? packBits(raw) : await inflate(raw));
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const px = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      px.set(p, o);
      o += p.length;
    }

    const rowBytes = Math.ceil((w * spp * bps) / 8);
    if (predictor === 2 && bps === 8) {
      for (let y = 0; y < h; y++) {
        for (let x = spp; x < w * spp; x++) px[y * rowBytes + x] = (px[y * rowBytes + x]! + px[y * rowBytes + x - spp]!) & 0xff;
      }
    }
    const cmap = tags.get(320);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = (y * w + x) * 4;
        let r: number, g: number, b: number;
        let a = 255;
        if (photo === 2) {
          const s = y * rowBytes + x * spp * (bps / 8);
          const step = bps / 8;
          r = px[s]!;
          g = px[s + step]!;
          b = px[s + 2 * step]!;
          if (spp >= 4) a = px[s + 3 * step]!;
        } else {
          const bitIdx = x * bps;
          const byte = px[y * rowBytes + (bitIdx >> 3)] ?? 0;
          let v = bps >= 8 ? byte : (byte >> (8 - bps - (bitIdx & 7))) & ((1 << bps) - 1);
          if (photo === 3 && cmap) {
            const nCol = 1 << bps;
            r = cmap[v]! >> 8;
            g = cmap[nCol + v]! >> 8;
            b = cmap[2 * nCol + v]! >> 8;
          } else {
            const max = bps >= 8 ? 255 : (1 << bps) - 1;
            v = Math.round((v * 255) / max);
            if (photo === 0) v = 255 - v;
            r = g = b = v;
          }
        }
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = b;
        out[d + 3] = a;
      }
    }
    frames.push({ width: w, height: h, data: out });
  }
  return frames;
}
