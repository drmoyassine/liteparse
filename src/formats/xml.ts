/** Tiny XML helpers for the OOXML / ODF readers (regex-level; inputs are machine-written XML). */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** Read an attribute value from a single start tag string. */
export function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]!) : undefined;
}

/** Normalise extracted text: trim lines, collapse blank runs. */
export function tidy(s: string): string {
  return s
    .replace(/[ \u00A0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
