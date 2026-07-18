// Regenerates the synthetic lab-report PDF fixtures in this directory:
//   en-cbc.pdf   EN multi-analyte CBC + basic metabolic panel (text layer)
//   lt-lab.pdf   Lithuanian lab report (decimal commas, LT diacritics)
//   scanned.pdf  image-only page with NO text layer (scanned-PDF stand-in)
//
// Hand-rolled writer (no dependencies): each character gets a CID, text is
// emitted as hex CID strings under a Type0/Identity-H font, and a ToUnicode
// CMap maps CIDs back to Unicode — which is all a text extractor (unpdf /
// pdfjs) needs. Run: `node fixtures/health-docs/generate.mjs`.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EN_CBC, fixtureLines, LT_LAB } from "./content.mjs";

const OUT_DIR = fileURLToPath(new URL(".", import.meta.url));

function hex(str, bytesPerToken) {
  return str.toString(16).padStart(bytesPerToken * 2, "0");
}

/** Builds a one-page PDF whose text layer renders `lines` top to bottom. */
export function buildTextPdf(lines) {
  // Assign sequential CIDs to every distinct character.
  const cidByChar = new Map();
  for (const line of lines) {
    for (const ch of line) {
      if (!cidByChar.has(ch)) cidByChar.set(ch, cidByChar.size + 1);
    }
  }
  const encode = (s) => [...s].map((ch) => hex(cidByChar.get(ch), 2)).join("");

  const contentLines = ["BT /F1 11 Tf 50 790 Td 16 TL"];
  lines.forEach((line, i) => {
    if (i > 0) contentLines.push("T*");
    if (line.length > 0) contentLines.push(`<${encode(line)}> Tj`);
  });
  contentLines.push("ET");
  const content = contentLines.join("\n");

  // ToUnicode bfchar entries, in spec-limited blocks of <= 100.
  const entries = [...cidByChar.entries()].map(
    ([ch, cid]) => `<${hex(cid, 2)}> <${hex(ch.codePointAt(0), 2)}>`,
  );
  const blocks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    blocks.push(`${slice.length} beginbfchar\n${slice.join("\n")}\nendbfchar`);
  }
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");

  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /FixtureSans /Encoding /Identity-H " +
      "/DescendantFonts [5 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureSans " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
      "/FontDescriptor 6 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /FixtureSans /Flags 4 " +
      "/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 " +
      "/CapHeight 700 /StemV 80 >>",
    `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

/** A page with graphics but no text operators — a scanned-PDF stand-in. */
export function buildScannedPdf() {
  const content =
    "0.88 0.88 0.88 rg\n60 600 475 120 re f\n0.2 0.2 0.2 RG\n2 w\n60 600 475 120 re S";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

/** Serializes objects (1-indexed) with a correct xref table. */
function assemblePdf(objects) {
  const chunks = ["%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"];
  const offsets = [];
  let position = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    position += chunk.length;
  });
  const xrefStart = position;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map(
      (offset) => `${offset.toString().padStart(10, "0")} 00000 n `,
    ),
  ].join("\n");
  const trailer =
    `${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([
    Buffer.from(chunks.join(""), "latin1"),
    Buffer.from(trailer, "latin1"),
  ]);
}

const fixtures = [
  [EN_CBC.filename, buildTextPdf(fixtureLines(EN_CBC))],
  [LT_LAB.filename, buildTextPdf(fixtureLines(LT_LAB))],
  ["scanned.pdf", buildScannedPdf()],
];
for (const [filename, bytes] of fixtures) {
  writeFileSync(`${OUT_DIR}${filename}`, bytes);
  console.log(`wrote ${filename} (${bytes.length} bytes)`);
}
