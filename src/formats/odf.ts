import JSZip from "jszip";
import { decodeEntities, stripTags, tidy } from "./xml.js";
import type { OfficeExtraction } from "./index.js";

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

/** .odt / .odp → pages (.odp: one per draw:page, speaker notes included). */
export async function extractOdf(bytes: Uint8Array, kind: "odt" | "odp"): Promise<OfficeExtraction> {
  const zip = await JSZip.loadAsync(bytes);
  const content = (await zip.file("content.xml")?.async("string")) ?? "";
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(content)?.[1] ?? content;
  const hasImages = Object.keys(zip.files).some((p) => p.startsWith("Pictures/"));
  if (kind === "odp") {
    const pages = [...body.matchAll(/<draw:page\b[\s\S]*?<\/draw:page>/g)].map((m) => {
      const [slide, notes] = m[0].split(/<presentation:notes\b/);
      const notesText = notes ? odfText(`<x${notes}`) : "";
      const text = odfText(slide!);
      return notesText ? `${text}\n\nNotes:\n${notesText}`.trim() : text;
    });
    return { pages, hasImages, format: "odp" };
  }
  return { pages: [odfText(body)], hasImages, format: "odt" };
}
