import { extractXlsx } from "../office.js";
import { extractDoc, extractPpt } from "./legacy.js";
import { extractOdf } from "./odf.js";
import { extractPptx } from "./pptx.js";
import { extractRtf } from "./rtf.js";
import type { DocKind } from "../types.js";

/** Result of a direct (pure-JS) office read. */
export interface OfficeExtraction {
  /** One entry per slide / page; single-entry for flowing documents. */
  pages: string[];
  /** The file embeds pictures (a reason to OCR via LibreOffice → PDF when text is sparse). */
  hasImages?: boolean;
  format: string;
  encoding?: string;
  warnings?: string[];
}

/** Options shared by the office readers. */
export interface OfficeReadOptions {
  /** "markdown": slide titles / headings → `#`, bullets → `-`, tables → GFM tables. Default plain text. */
  structure?: "plain" | "markdown";
}

/** Kinds read by {@link extractOffice} (the router's `office` engine). */
export const OFFICE_KINDS: ReadonlySet<DocKind> = new Set(["pptx", "odt", "odp", "rtf", "doc", "ppt", "ods", "xls"]);

/** Read an office file directly in pure JS (browser, Node, edge alike). Throws when unreadable. */
export async function extractOffice(kind: DocKind, bytes: Uint8Array, opts: OfficeReadOptions = {}): Promise<OfficeExtraction> {
  switch (kind) {
    case "pptx":
      return extractPptx(bytes, opts);
    case "odt":
    case "odp":
      return extractOdf(bytes, kind, opts);
    case "rtf":
      return extractRtf(bytes);
    case "doc":
      return extractDoc(bytes);
    case "ppt":
      return extractPpt(bytes);
    case "ods":
    case "xls":
      return { pages: [extractXlsx(bytes, opts)], format: kind };
    default:
      throw new Error(`office: unsupported kind ${kind}`);
  }
}
