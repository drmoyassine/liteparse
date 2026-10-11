import * as XLSX from "xlsx";
import type { OfficeExtraction } from "./index.js";

/**
 * Legacy binary readers (.doc / .ppt) over SheetJS's compound-file (CFB) reader —
 * the same pure-JS dependency already used for spreadsheets. Text only; anything
 * unreadable (Word 6/95, PowerPoint 95, encrypted) throws so the caller can fall
 * back to LibreOffice conversion on the runner.
 */

type CfbEntry = { name: string; content?: Uint8Array | number[] };

function openCfb(bytes: Uint8Array) {
  return XLSX.CFB.read(bytes, { type: "array" });
}

function stream(cfb: ReturnType<typeof openCfb>, name: string): Uint8Array | null {
  const e = XLSX.CFB.find(cfb, name) as CfbEntry | null;
  if (!e?.content) return null;
  return e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content);
}

/** Which legacy Office app wrote this compound file. */
export function legacyKind(bytes: Uint8Array): "doc" | "xls" | "ppt" | null {
  try {
    const cfb = openCfb(bytes);
    if (stream(cfb, "WordDocument")) return "doc";
    if (stream(cfb, "PowerPoint Document")) return "ppt";
    if (stream(cfb, "Workbook") || stream(cfb, "Book")) return "xls";
  } catch {
    // not a readable CFB
  }
  return null;
}

/* ─────────────────────────────── .doc ─────────────────────────────── */

const W_SPECIAL: Record<number, string> = { 0x0d: "\n", 0x07: "\t", 0x0b: "\n", 0x0c: "\n", 0x1e: "-", 0x09: "\t" };

/** Strip field instructions (keep field results) and map Word control chars. */
function cleanWordText(raw: string): { text: string; objects: number } {
  let out = "";
  let objects = 0;
  const fields: boolean[] = []; // per open field: in result part?
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c === 0x13) {
      fields.push(false);
      continue;
    }
    if (c === 0x14) {
      if (fields.length) fields[fields.length - 1] = true;
      continue;
    }
    if (c === 0x15) {
      fields.pop();
      continue;
    }
    if (fields.some((inResult) => !inResult)) continue;
    if (c === 0x01 || c === 0x08) {
      objects++;
      continue;
    }
    if (W_SPECIAL[c] !== undefined) out += W_SPECIAL[c];
    else if (c >= 0x20 || c === 0x0a) out += ch;
  }
  return { text: out, objects };
}

export function extractDoc(bytes: Uint8Array): OfficeExtraction {
  const cfb = openCfb(bytes);
  const wd = stream(cfb, "WordDocument");
  if (!wd || wd.length < 0x1aa) throw new Error("doc: WordDocument stream missing");
  const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (dv.getUint16(0, true) !== 0xa5ec) throw new Error("doc: not a Word 97+ file (Word 6/95?)");
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error("doc: encrypted");
  const table = stream(cfb, flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error("doc: table stream missing");

  // FibBase(32) → csw + fibRgW → cslw + fibRgLw → cbRgFcLcb + fibRgFcLcb.
  const csw = dv.getUint16(32, true);
  const lwOff = 34 + csw * 2 + 2;
  const ccpText = dv.getInt32(lwOff + 12, true);
  const ccpFtn = dv.getInt32(lwOff + 16, true);
  const ccpHdd = dv.getInt32(lwOff + 20, true);
  const cslw = dv.getUint16(34 + csw * 2, true);
  const fcLcbOff = lwOff + cslw * 4 + 2;
  const fcClx = dv.getUint32(fcLcbOff + 33 * 8, true);
  const lcbClx = dv.getUint32(fcLcbOff + 33 * 8 + 4, true);
  if (!lcbClx || fcClx + lcbClx > table.length) throw new Error("doc: no piece table");

  // Clx: skip Prc entries (0x01), then Pcdt (0x02) → PlcPcd.
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let p = fcClx;
  while (table[p] === 0x01) p += 3 + tv.getInt16(p + 1, true);
  if (table[p] !== 0x02) throw new Error("doc: malformed piece table");
  const lcb = tv.getUint32(p + 1, true);
  const plc = p + 5;
  const n = (lcb - 4) / 12;
  let raw = "";
  for (let i = 0; i < n; i++) {
    const cpStart = tv.getUint32(plc + i * 4, true);
    const cpEnd = tv.getUint32(plc + (i + 1) * 4, true);
    const fcRaw = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const len = cpEnd - cpStart;
    if (fcRaw & 0x40000000) {
      const fc = (fcRaw & 0x3fffffff) / 2;
      raw += new TextDecoder("windows-1252").decode(wd.subarray(fc, fc + len));
    } else {
      raw += new TextDecoder("utf-16le").decode(wd.subarray(fcRaw, fcRaw + len * 2));
    }
  }

  const main = cleanWordText(raw.slice(0, ccpText));
  const ftn = cleanWordText(raw.slice(ccpText, ccpText + ccpFtn));
  const hdd = cleanWordText(raw.slice(ccpText + ccpFtn, ccpText + ccpFtn + ccpHdd));
  const parts = [main.text.trim()];
  if (ftn.text.trim()) parts.push(`Footnotes:\n${ftn.text.trim()}`);
  const headers = [...new Set(hdd.text.split("\n").map((l) => l.trim()).filter(Boolean))].join("\n");
  if (headers) parts.push(`Headers/footers:\n${headers}`);
  const text = parts.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { pages: [text], hasImages: main.objects > 0, format: "doc" };
}

/* ─────────────────────────────── .ppt ─────────────────────────────── */

const RT = {
  slide: 0x03ee,
  notes: 0x03f0,
  mainMaster: 0x03f8,
  slideListWithText: 0x0ff0,
  slidePersistAtom: 0x03f3,
  textChars: 0x0fa0,
  textBytes: 0x0fa8,
  handout: 0x0fc9,
  notesAtom: 0x03f1,
} as const;

export function extractPpt(bytes: Uint8Array): OfficeExtraction {
  const cfb = openCfb(bytes);
  const s = stream(cfb, "PowerPoint Document");
  if (!s || s.length < 8) throw new Error("ppt: PowerPoint Document stream missing");
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const slwtSlides: string[][] = [];
  const slwtNotes: string[][] = [];
  const slideTexts: string[][] = [];
  const noteTexts: Array<{ ref: number; text: string[] }> = [];
  const slideIds: number[] = [];
  let pictures = false;

  const walk = (start: number, end: number, ctx: { list?: string[][]; target?: string[] | null; slideIdRef?: number }) => {
    let off = start;
    while (off + 8 <= end) {
      const verInst = dv.getUint16(off, true);
      const type = dv.getUint16(off + 2, true);
      const len = dv.getUint32(off + 4, true);
      const body = off + 8;
      const next = body + len;
      if (next > end || next <= off) break;
      if ((verInst & 0x0f) === 0x0f) {
        if (type === RT.slide) {
          const t: string[] = [];
          slideTexts.push(t);
          walk(body, next, { target: t });
        } else if (type === RT.notes) {
          const t: string[] = [];
          const nctx: { target: string[]; slideIdRef?: number } = { target: t };
          walk(body, next, nctx);
          if (nctx.slideIdRef) noteTexts.push({ ref: nctx.slideIdRef, text: t }); // 0 ⇒ notes master
        } else if (type === RT.mainMaster || type === RT.handout) {
          // master / handout text is template boilerplate
        } else if (type === RT.slideListWithText) {
          const inst = verInst >> 4;
          walk(body, next, { list: inst === 0 ? slwtSlides : inst === 2 ? slwtNotes : undefined, target: null });
        } else {
          walk(body, next, ctx);
        }
      } else if (type === RT.notesAtom && len >= 4) {
        (ctx as { slideIdRef?: number }).slideIdRef = dv.getUint32(body, true);
      } else if (type === RT.slidePersistAtom && ctx.list) {
        if (ctx.list === slwtSlides && len >= 16) slideIds.push(dv.getUint32(body + 12, true));
        ctx.target = [];
        ctx.list.push(ctx.target);
      } else if ((type === RT.textChars || type === RT.textBytes) && ctx.target) {
        const raw = s.subarray(body, next);
        const str = type === RT.textChars ? new TextDecoder("utf-16le").decode(raw) : new TextDecoder("latin1").decode(raw);
        ctx.target.push(str.replace(/[\r\v]/g, "\n").trim());
      } else if (type === 0xf007 || type === 0xf01e || type === 0xf01d) {
        pictures = true; // OfficeArt BSE / blip
      }
      off = next;
    }
  };
  walk(0, s.length, {});

  const count = Math.max(slwtSlides.length, slideTexts.length);
  const pages: string[] = [];
  for (let i = 0; i < count; i++) {
    const lines = [...(slwtSlides[i] ?? []), ...(slideTexts[i] ?? [])].flatMap((t) => t.split("\n")).map((l) => l.trim()).filter(Boolean);
    let text = [...new Set(lines)].join("\n");
    const notes = [...new Set([...(slwtNotes[i] ?? []), ...noteTexts.filter((nt) => nt.ref === slideIds[i]).flatMap((nt) => nt.text)].flatMap((t) => t.split("\n")).map((l) => l.trim()).filter((l) => l && l !== "*"))];
    if (notes.length) text = `${text}\n\nNotes:\n${notes.join("\n")}`.trim();
    pages.push(text);
  }
  if (pages.length === 0) throw new Error("ppt: no slides found (PowerPoint 95 or damaged?)");
  return { pages, hasImages: pictures, format: "ppt" };
}
