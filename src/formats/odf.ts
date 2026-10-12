import JSZip from "jszip";
import { attr, decodeEntities, stripTags, tidy } from "./xml.js";
import { mdHeading, mdJoin, mdTable } from "./markdown.js";
import type { OfficeExtraction, OfficeReadOptions } from "./index.js";

/** ODF text:* markup → plain text (spaces, tabs, line breaks, paragraph ends). */
function odfText(xml: string): string {
  const s = xml
    .replace(/<text:page-number\b[^>]*>[\s\S]*?<\/text:page-number>/g, "")
    .replace(/<text:s\b([^>]*)\/>/g, (_m, a: string) => " ".repeat(Number(/text:c="(\d+)"/.exec(a)?.[1] ?? 1)))
    .replace(/<text:tab\b[^>]*\/>/g, "\t")
    .replace(/<text:line-break\b[^>]*\/>/g, "\n")
    .replace(/<\/text:(p|h)>/g, "\n")
    .replace(/<text:(p|h)\b[^>]*\/>/g, "\n")
    .replace(/<\/table:table-cell>/g, "\t")
    .replace(/<\/table:table-row>/g, "\n");
  return tidy(decodeEntities(stripTags(s)).replace(/\n+\t/g, "\t"));
}

/** <table:table> → Markdown rows. */
function odfTable(xml: string): string {
  const rows = [...xml.matchAll(/<table:table-row\b[\s\S]*?<\/table:table-row>/g)].map((r) =>
    [...r[0].matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].map((c) => odfText(c[1] ?? "")),
  );
  return mdTable(rows);
}

/**
 * ODF body → Markdown: text:h (outline level) → headings, text:list-item → "- ", tables →
 * GFM tables, other paragraphs kept. Walks the top-level blocks in document order.
 */
function odfMarkdown(xml: string): string {
  const blocks: string[] = [];
  const re = /<text:h\b[^>]*>[\s\S]*?<\/text:h>|<text:list\b[\s\S]*?<\/text:list>|<table:table\b[\s\S]*?<\/table:table>|<text:p\b[^>]*?(?:\/>|>[\s\S]*?<\/text:p>)/g;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    if (block.startsWith("<text:h")) {
      const level = Number(attr(/<text:h\b[^>]*>/.exec(block)![0], "text:outline-level") ?? 1) || 1;
      blocks.push(mdHeading(level, odfText(block)));
    } else if (block.startsWith("<text:list")) {
      const items = [...block.matchAll(/<text:list-item\b[\s\S]*?<\/text:list-item>/g)].map((i) => odfText(i[0])).filter(Boolean);
      blocks.push(items.map((i) => `- ${i.replace(/\n+/g, " ")}`).join("\n"));
    } else if (block.startsWith("<table:table")) {
      blocks.push(odfTable(block));
    } else {
      blocks.push(odfText(block));
    }
  }
  return mdJoin(blocks);
}

/** ODP slide → Markdown: the title frame as a heading, outline frames as lists, tables as tables. */
function odpSlideMarkdown(slide: string): string {
  const blocks: string[] = [];
  for (const m of slide.matchAll(/<draw:frame\b[\s\S]*?<\/draw:frame>/g)) {
    const frame = m[0];
    const cls = attr(/<draw:frame\b[^>]*>/.exec(frame)![0], "presentation:class");
    if (/<table:table\b/.test(frame)) {
      blocks.push(odfTable(frame));
      continue;
    }
    const text = odfText(frame);
    if (!text) continue;
    if (cls === "title") blocks.push(mdHeading(1, text));
    else if (cls === "subtitle") blocks.push(mdHeading(2, text));
    else if (cls === "outline") blocks.push(text.split("\n").filter(Boolean).map((l) => `- ${l}`).join("\n"));
    else if (cls === "page-number" || cls === "footer" || cls === "date-time" || cls === "header") continue;
    else blocks.push(text);
  }
  return mdJoin(blocks);
}

/** .odt / .odp → pages (.odp: one per draw:page, speaker notes included). */
export async function extractOdf(bytes: Uint8Array, kind: "odt" | "odp", opts: OfficeReadOptions = {}): Promise<OfficeExtraction> {
  const md = opts.structure === "markdown";
  const zip = await JSZip.loadAsync(bytes);
  const content = (await zip.file("content.xml")?.async("string")) ?? "";
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(content)?.[1] ?? content;
  const hasImages = Object.keys(zip.files).some((p) => p.startsWith("Pictures/"));
  if (kind === "odp") {
    const pages = [...body.matchAll(/<draw:page\b[\s\S]*?<\/draw:page>/g)].map((m) => {
      const [slide, notes] = m[0].split(/<presentation:notes\b/);
      const notesText = notes ? odfText(`<x${notes}`) : "";
      const text = md ? odpSlideMarkdown(slide!) : odfText(slide!);
      if (!notesText) return text;
      return md ? mdJoin([text, `**Notes:**\n\n${notesText}`]) : `${text}\n\nNotes:\n${notesText}`.trim();
    });
    return { pages, hasImages, format: "odp" };
  }
  return { pages: [md ? odfMarkdown(body) : odfText(body)], hasImages, format: "odt" };
}
