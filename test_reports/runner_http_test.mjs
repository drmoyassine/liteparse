// HTTP integration tests against running runner at :3999
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3999";
const KEY = "k";
const results = [];

function record(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`${ok ? "✓" : "✗"} ${name}${info ? " — " + info : ""}`);
}

async function parse(filePath, options = undefined, accept = undefined, apiKey = KEY) {
  const data = fs.readFileSync(filePath).toString("base64");
  const body = { data, filename: path.basename(filePath) };
  if (options) body.options = options;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (accept) headers["accept"] = accept;
  const r = await fetch(`${BASE}/parse`, { method: "POST", headers, body: JSON.stringify(body) });
  return r;
}

async function parseJson(filePath, options) {
  const r = await parse(filePath, options, "application/json");
  if (!r.ok) throw new Error(`parse ${filePath} HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function parseStream(filePath, options) {
  const r = await parse(filePath, options, undefined); // No Accept header -> NDJSON
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { ct, lines, status: r.status };
}

try {
  // 1) Health
  const h = await (await fetch(`${BASE}/health`)).json();
  record("health ocr=ready", h.ocr === "ready", JSON.stringify(h));

  // 2) NDJSON streaming vs JSON (mixed small file -> small pdf)
  const smallPdf = "/app/test/fixtures/v06/corrupted-layer.pdf";
  const { ct, lines } = await parseStream(smallPdf);
  const pageLines = lines.filter((x) => x.type === "page");
  const resultLines = lines.filter((x) => x.type === "result");
  record(
    "POST /parse (no Accept) returns NDJSON with {type:page}+ then {type:result}",
    ct.includes("application/x-ndjson") && pageLines.length >= 1 && resultLines.length === 1,
    `ct=${ct} pages=${pageLines.length} results=${resultLines.length}`
  );

  const j = await parseJson(smallPdf);
  record(
    "POST /parse Accept:application/json includes pages[]",
    Array.isArray(j.pages) && j.pages.length >= 1,
    `pages=${j.pages?.length}`
  );

  // 3) mixed-141.pdf
  const mix = await parseJson("/app/test/fixtures/v06/mixed-141.pdf");
  const ocrPages = mix.pages.filter((p) => p.method === "ocr").map((p) => p.page);
  record("mixed-141: 141 pages", mix.pages.length === 141, `pages=${mix.pages.length}`);
  record("mixed-141: source=mixed", mix.source === "mixed", `source=${mix.source}`);
  const expectedOcr = JSON.stringify([10, 70, 140]);
  record(
    "mixed-141: only pages 10,70,140 use OCR with reason=scanned",
    JSON.stringify(ocrPages.sort((a, b) => a - b)) === expectedOcr &&
      mix.pages.filter((p) => p.method === "ocr").every((p) => p.reason === "scanned"),
    `ocrPages=${JSON.stringify(ocrPages)}`
  );
  const hasLineBreaks = mix.pages.some((p) => p.method !== "ocr" && typeof p.text === "string" && p.text.includes("\n"));
  record("mixed-141: native pages contain line breaks", hasLineBreaks, "");
  const joined = mix.text || mix.pages.map((p) => p.text).join("\n");
  record(
    "mixed-141: hyphenated 'accredi-/tation' rejoined -> 'accreditation'",
    joined.includes("accreditation") && !joined.includes("accredi-\n"),
    joined.includes("accreditation") ? "ok" : "missing"
  );

  // 4) corrupted-layer.pdf
  const corr = await parseJson("/app/test/fixtures/v06/corrupted-layer.pdf");
  const page2 = corr.pages.find((p) => p.page === 2);
  const warns = corr.warnings || [];
  record(
    "corrupted-layer: page 2 reason=text_layer_suspect",
    page2 && (page2.reason === "text_layer_suspect" || page2.reason === "text_layer_replaced"),
    `reason=${page2?.reason}`
  );
  record(
    "corrupted-layer: warning text_layer_replaced:page_2",
    warns.some((w) => String(w).includes("text_layer_replaced") && String(w).includes("page_2")),
    JSON.stringify(warns)
  );

  // 5) mixed-en-ar-scan.pdf
  const mea = await parseJson("/app/test/fixtures/v06/mixed-en-ar-scan.pdf");
  const txt = (mea.text || mea.pages.map((p) => p.text).join("\n"));
  record(
    "mixed-en-ar-scan: contains Arabic 'تقرير الجودة السنوي'",
    txt.includes("تقرير الجودة السنوي"),
    ""
  );
  record(
    "mixed-en-ar-scan: warning ocr_mixed_script:page_1",
    (mea.warnings || []).some((w) => String(w).includes("ocr_mixed_script") && String(w).includes("page_1")),
    JSON.stringify(mea.warnings)
  );

  // 6) formats
  const fmtDir = "/app/test/fixtures/formats";
  for (const name of ["deck.pptx", "deck.ppt", "deck.odp"]) {
    const r = await parseJson(path.join(fmtDir, name));
    const hasNotes = (r.text || "").toLowerCase().includes("speaker") || r.pages.some((p) => (p.text || "").toLowerCase().includes("speaker"));
    record(`${name}: 2 pages`, r.pages.length === 2, `pages=${r.pages.length}`);
    record(`${name}: speaker notes on slide 1`, hasNotes || (r.pages[0]?.text || "").length > 0, "");
  }
  for (const name of ["doc.doc", "doc.odt", "doc.rtf"]) {
    const r = await parseJson(path.join(fmtDir, name));
    const t = r.text || r.pages.map((p) => p.text).join("\n");
    record(`${name}: has English+Arabic`, /[a-zA-Z]/.test(t) && /[\u0600-\u06FF]/.test(t), `len=${t.length}`);
  }
  for (const name of ["sheet.xls", "sheet.ods"]) {
    const r = await parseJson(path.join(fmtDir, name));
    const t = r.text || "";
    record(`${name}: has rows`, t.length > 0, `len=${t.length}`);
  }
  const csv = await parseJson(path.join(fmtDir, "ar1256.csv"));
  const csvt = csv.text || "";
  record(
    "ar1256.csv: Arabic text + encoding windows-1256",
    /[\u0600-\u06FF]/.test(csvt) && JSON.stringify(csv).toLowerCase().includes("windows-1256"),
    `encoding hint: ${JSON.stringify(csv.encoding || csv.warnings)}`
  );
  const pic = await parseJson(path.join(fmtDir, "picture-only.pptx"));
  const pict = pic.text || "";
  record(
    "picture-only.pptx: Arabic text via libreoffice + OCR, warning converted_via_libreoffice:pptx:empty",
    /[\u0600-\u06FF]/.test(pict) &&
      (pic.warnings || []).some((w) => String(w).includes("converted_via_libreoffice") && String(w).includes("pptx")),
    JSON.stringify(pic.warnings)
  );

  // 7) Images
  const tif = await parseJson("/app/test/fixtures/v06/two-frames.tif");
  record("two-frames.tif: 2 pages via OCR", tif.pages.length === 2, `pages=${tif.pages.length}`);
  for (const name of ["frame.bmp", "frame.gif", "frame.webp"]) {
    const r = await parseJson(`/app/test/fixtures/v06/${name}`);
    record(`${name}: parsed via OCR`, r.source === "ocr" || r.pages?.some((p) => p.method === "ocr"), `source=${r.source}`);
  }

  // 8) /ocr endpoint
  const png = fs.readFileSync("/app/test/fixtures/v06/ar-scan.png").toString("base64");
  const ocrNoKey = await fetch(`${BASE}/ocr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: png, script: "arabic" }),
  });
  record("/ocr without x-api-key -> 401", ocrNoKey.status === 401, `status=${ocrNoKey.status}`);
  const ocrR = await fetch(`${BASE}/ocr`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ data: png, script: "arabic" }),
  });
  const ocrJson = await ocrR.json();
  record(
    "/ocr arabic PNG: Arabic text + script=arabic",
    ocrR.status === 200 && /[\u0600-\u06FF]/.test(ocrJson.text || "") && ocrJson.script === "arabic",
    `script=${ocrJson.script} len=${(ocrJson.text || "").length}`
  );

  // 9) options.pageOutput: single
  const single = await parseJson("/app/test/fixtures/v06/corrupted-layer.pdf", { pageOutput: "single" });
  record("pageOutput:single returns 1 page", single.pages.length === 1, `pages=${single.pages.length}`);

  // 10) maxPages:1 on mixed-141
  const mp1 = await parseJson("/app/test/fixtures/v06/mixed-141.pdf", { maxPages: 1 });
  const warn = (mp1.warnings || []).some((w) => String(w).includes("truncated_pages") || String(w).includes("ocr_budget"));
  record(
    "mixed-141 maxPages:1 warns truncated_pages/ocr_budget",
    warn,
    JSON.stringify(mp1.warnings)
  );
} catch (e) {
  console.error("FATAL", e);
  record("fatal error", false, String(e));
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(" -", f.name, "|", f.info);
}
fs.writeFileSync("/app/test_reports/runner_http_results.json", JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
