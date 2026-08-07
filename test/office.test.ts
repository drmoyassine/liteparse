import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { decodeText, extractDocx, extractXlsx } from "../src/office.js";
import { makeDocx } from "./helpers/zip.js";

describe("extractDocx", () => {
  it("extracts body text from a synthesised .docx", async () => {
    const docx = await makeDocx("This is a test paragraph in the document body.");
    const text = await extractDocx(docx);
    expect(text).toContain("This is a test paragraph in the document body.");
  });

  it("produces empty text for a body with no runs", async () => {
    const docx = await makeDocx("");
    const text = await extractDocx(docx);
    expect(text.trim()).toBe("");
  });
});

describe("extractXlsx", () => {
  it("round-trips a single-sheet workbook to CSV", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "City"],
      ["Alice", "Casablanca"],
      ["Bob", "Rabat"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "People");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const text = extractXlsx(bytes);
    expect(text).toContain("Name");
    expect(text).toContain("Casablanca");
    expect(text).toContain("Rabat");
  });

  it("labels each sheet when there are multiple", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a1"]]), "Sheet1");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["b1"]]), "Sheet2");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const text = extractXlsx(bytes);
    expect(text).toContain("# Sheet1");
    expect(text).toContain("# Sheet2");
    expect(text).toContain("a1");
    expect(text).toContain("b1");
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("héllo, 世界");
    expect(decodeText(bytes)).toBe("héllo, 世界");
  });

  it("decodes CSV content", () => {
    const bytes = new TextEncoder().encode("a,b,c\n1,2,3");
    expect(decodeText(bytes)).toBe("a,b,c\n1,2,3");
  });
});
