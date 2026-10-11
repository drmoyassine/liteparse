import JSZip from "jszip";
import { attr, decodeEntities, tidy } from "./xml.js";
import type { OfficeExtraction } from "./index.js";

/** DrawingML paragraphs (<a:p>) → lines; <a:br/> → line break. */
function drawingText(xml: string): string {
  const lines: string[] = [];
  for (const m of xml.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
    const body = m[1] ?? "";
    let line = "";
    for (const r of body.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:t\b[^>]*\/>|<a:br\b[^>]*\/>|<a:tab\b[^>]*\/>/g)) {
      if (r[0].startsWith("<a:br")) line += "\n";
      else if (r[0].startsWith("<a:tab")) line += "\t";
      else line += decodeEntities(r[1] ?? "");
    }
    lines.push(line);
  }
  return tidy(lines.join("\n"));
}

function relsMap(xml: string | undefined): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const m of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) map.set(id, { target, type: attr(m[0], "Type") ?? "" });
  }
  return map;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Notes slides: drop the slide-image and slide-number placeholders. */
function notesText(xml: string): string {
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
    .map((m) => m[0])
    .filter((sp) => !/<p:ph\b[^>]*type="(sldNum|sldImg|hdr|ftr|dt)"/.test(sp));
  return tidy(shapes.map(drawingText).join("\n"));
}

/** .pptx → one page per slide (in presentation order), speaker notes appended. */
export async function extractPptx(bytes: Uint8Array): Promise<OfficeExtraction> {
  const zip = await JSZip.loadAsync(bytes);
  const read = (p: string) => zip.file(p)?.async("string");
  const pres = (await read("ppt/presentation.xml")) ?? "";
  const presRels = relsMap(await read("ppt/_rels/presentation.xml.rels"));

  let slidePaths = [...pres.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => presRels.get(attr(m[0], "r:id") ?? "")?.target)
    .filter((t): t is string => !!t)
    .map((t) => resolvePath("ppt/presentation.xml", t));
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  }

  const pages: string[] = [];
  for (const path of slidePaths) {
    const xml = (await read(path)) ?? "";
    let text = drawingText(xml);
    const relsPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
    const rels = relsMap(await read(relsPath));
    for (const rel of rels.values()) {
      if (!rel.type.endsWith("/notesSlide")) continue;
      const notes = notesText((await read(resolvePath(path, rel.target))) ?? "");
      if (notes) text = `${text}\n\nNotes:\n${notes}`.trim();
    }
    pages.push(text);
  }
  const hasImages = Object.keys(zip.files).some((p) => p.startsWith("ppt/media/"));
  return { pages, hasImages, format: "pptx" };
}
