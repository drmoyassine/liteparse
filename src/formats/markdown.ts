/** Markdown rendering helpers shared by the office readers (`structure: "markdown"`). */

/** Escape a table cell: pipes and line breaks can't live inside a Markdown row. */
export function mdCell(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** Rows → a GFM table (first row is the header). Empty input → "". */
export function mdTable(rows: string[][]): string {
  const filled = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (filled.length === 0) return "";
  const width = Math.max(...filled.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")].map(mdCell);
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const [head, ...body] = filled;
  return [line(head!), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

export function mdHeading(level: number, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? `${"#".repeat(Math.min(6, Math.max(1, level)))} ${t}` : "";
}

/** Each non-empty line becomes a list item. */
export function mdList(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join("\n");
}

/** Join blocks with blank lines, dropping empties. */
export function mdJoin(blocks: string[]): string {
  return blocks.map((b) => b.trim()).filter(Boolean).join("\n\n");
}
