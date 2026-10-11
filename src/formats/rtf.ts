import { codePageLabel, decodeCodePage } from "../text/encoding.js";
import type { OfficeExtraction } from "./index.js";

/**
 * RTF → plain text. Handles groups, \uN Unicode escapes (with \ucN skip counts),
 * \'hh bytes decoded with the active code page (\ansicpg, or the current font's
 * \fcharset — e.g. 178 → windows-1256 for Arabic), and skips non-text destinations.
 */

const CHARSET_CP: Record<number, number> = {
  0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254,
  163: 1258, 177: 1255, 178: 1256, 179: 1256, 180: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};

const SKIP_DESTS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "colorschememapping",
  "datastore", "latentstyles", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl",
  "mmathPr", "fldinst", "filetbl", "revtbl", "pgdsctbl", "objdata", "bkmkstart", "bkmkend", "nonshppict",
  "shpinst", "userprops", "operator", "author", "title", "subject", "keywords", "comment", "doccomm",
]);

const SYMBOLS: Record<string, string> = {
  par: "\n", line: "\n", sect: "\n\n", page: "\n", tab: "\t", cell: "\t", row: "\n", nestcell: "\t",
  emdash: "\u2014", endash: "\u2013", lquote: "\u2018", rquote: "\u2019", ldblquote: "\u201C",
  rdblquote: "\u201D", bullet: "\u2022", emspace: " ", enspace: " ", qmspace: " ",
};

interface GroupState {
  uc: number;
  skip: boolean;
  font: number;
  fontTable: boolean;
}

export function extractRtf(bytes: Uint8Array): OfficeExtraction {
  const src = new TextDecoder("latin1").decode(bytes);
  let docCp = 1252;
  const fontCp = new Map<number, number>();
  let st: GroupState = { uc: 1, skip: false, font: -1, fontTable: false };
  const stack: GroupState[] = [];
  let out = "";
  let pending: number[] = [];
  let skipChars = 0;
  let tableFont = -1;
  let hasImages = false;
  let groupStart = false;

  const flush = () => {
    if (pending.length === 0) return;
    const cp = fontCp.get(st.font) ?? docCp;
    if (!st.skip) out += decodeCodePage(Uint8Array.from(pending), codePageLabel(cp));
    pending = [];
  };
  const emit = (s: string) => {
    if (skipChars > 0) {
      skipChars--;
      return;
    }
    flush();
    if (!st.skip) out += s;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "{") {
      flush();
      stack.push(st);
      st = { ...st };
      groupStart = true;
      continue;
    }
    if (c === "}") {
      flush();
      st = stack.pop() ?? st;
      groupStart = false;
      continue;
    }
    if (c === "\\") {
      const next = src[i + 1] ?? "";
      if (/[a-zA-Z]/.test(next)) {
        const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40))!;
        i += m[0].length;
        const word = m[1]!;
        const param = m[2] !== undefined ? Number(m[2]) : undefined;
        const first = groupStart;
        groupStart = false;
        if (word === "fonttbl") {
          st.fontTable = true;
          st.skip = true;
          continue;
        }
        if (st.fontTable) {
          if (word === "f" && param !== undefined) tableFont = param;
          if (word === "fcharset" && param !== undefined && CHARSET_CP[param]) fontCp.set(tableFont, CHARSET_CP[param]!);
          if (word === "cpg" && param !== undefined) fontCp.set(tableFont, param);
          continue;
        }
        if (first && SKIP_DESTS.has(word)) {
          if (word === "pict" || word === "object") hasImages = true;
          st.skip = true;
          continue;
        }
        if (word === "ansicpg" && param !== undefined) docCp = param;
        else if (word === "f" && param !== undefined) {
          flush();
          st.font = param;
        } else if (word === "uc" && param !== undefined) st.uc = param;
        else if (word === "u" && param !== undefined) {
          emit(String.fromCharCode(param < 0 ? param + 65536 : param));
          skipChars = st.uc;
        } else if (SYMBOLS[word]) emit(SYMBOLS[word]!);
        continue;
      }
      groupStart = false;
      i++;
      if (next === "'") {
        const byte = parseInt(src.slice(i + 1, i + 3), 16);
        i += 2;
        if (skipChars > 0) skipChars--;
        else if (Number.isFinite(byte)) pending.push(byte);
      } else if (next === "*") {
        st.skip = true;
      } else if (next === "~") emit("\u00A0");
      else if (next === "_") emit("-");
      else if (next === "\\" || next === "{" || next === "}") emit(next);
      else if (next === "\n" || next === "\r") emit("\n");
      continue;
    }
    groupStart = false;
    if (c === "\r" || c === "\n") continue;
    emit(c);
  }
  flush();

  const text = out
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").trimStart())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { pages: [text], hasImages, format: "rtf", encoding: codePageLabel(docCp) };
}
