// Regenerates the synthetic lab-report fixtures in this directory:
//   en-cbc.pdf      EN multi-analyte CBC + basic metabolic panel (text layer)
//   lt-lab.pdf      Lithuanian lab report (decimal commas, LT diacritics)
//   scanned.pdf     graphics-only page with NO text layer (no real content)
//   scanned-lab.pdf image-only PDF of the EN report — a real scanned lab
//                   report stand-in: the page is a JPEG, there is no text
//                   layer at all (for the vision extraction path)
//   lab-photo.jpg   JPEG render of the LT report — a "photo of a lab report"
//                   stand-in for document_type image ingestion
//
// Hand-rolled writer (no npm dependencies): each character gets a CID, text
// is emitted as hex CID strings under a Type0/Identity-H font, and a ToUnicode
// CMap maps CIDs back to Unicode — which is all a text extractor (unpdf /
// pdfjs) needs. The image-only fixtures render the text PDFs with poppler's
// pdftoppm, so regenerating requires poppler-utils installed locally:
//   node fixtures/health-docs/generate.mjs

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Width/height of a JPEG from its SOF marker (pdftoppm emits SOF0). Throws on
 * malformed input — fixture bytes are generated, never adversarial.
 */
export function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("not a JPEG (missing SOI)");
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue; // tolerate stray bytes between segments
    }
    const marker = bytes[offset + 1];
    // Standalone markers (no length): SOI, EOI, RSTn, TEM.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0/SOF2 carry the frame dimensions.
    if (marker === 0xc0 || marker === 0xc2) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("no SOF marker found");
}

/**
 * Builds an image-only PDF: one A4 page per JPEG, each drawn as a full-page
 * DCTDecode XObject. No text layer anywhere — the scanned-document stand-in
 * for the vision extraction path.
 */
export function buildImagePdf(jpegs) {
  const pageObjectIds = jpegs.map((_, i) => 3 + i * 3);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${jpegs.length} >>`,
  ];
  jpegs.forEach((jpeg, i) => {
    const { width, height } = jpegSize(jpeg);
    const pageId = 3 + i * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const content = `q\n595 0 0 842 0 0 cm\n/Im${i} Do\nQ`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /XObject << /Im${i} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
          "latin1",
        ),
        jpeg,
        Buffer.from("\nendstream", "latin1"),
      ]),
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  return assemblePdf(objects);
}

/**
 * Renders every page of a PDF to a JPEG with poppler's pdftoppm (the same
 * rasterizer the worker's vision path uses), sorted page by page.
 */
export function renderPdfToJpegs(pdfPath, dpi = 150) {
  const dir = mkdtempSync(join(tmpdir(), "fixture-render-"));
  try {
    execFileSync("pdftoppm", ["-jpeg", "-r", String(dpi), pdfPath, join(dir, "page")]);
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .sort()
      .map((name) => readFileSync(join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Serializes objects (1-indexed) with a correct xref table. */
function assemblePdf(objects) {
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let position = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.isBuffer(body)
      ? Buffer.concat([
          Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
          body,
          Buffer.from("\nendobj\n", "latin1"),
        ])
      : Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
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
  return Buffer.concat([...chunks, Buffer.from(trailer, "latin1")]);
}

const enCbcPdf = buildTextPdf(fixtureLines(EN_CBC));
const ltLabPdf = buildTextPdf(fixtureLines(LT_LAB));

function main() {
  writeFileSync(`${OUT_DIR}${EN_CBC.filename}`, enCbcPdf);
  console.log(`wrote ${EN_CBC.filename} (${enCbcPdf.length} bytes)`);
  writeFileSync(`${OUT_DIR}${LT_LAB.filename}`, ltLabPdf);
  console.log(`wrote ${LT_LAB.filename} (${ltLabPdf.length} bytes)`);
  const scannedPdf = buildScannedPdf();
  writeFileSync(`${OUT_DIR}scanned.pdf`, scannedPdf);
  console.log(`wrote scanned.pdf (${scannedPdf.length} bytes)`);

  // Image-only fixtures: render the text PDFs with poppler, then re-embed the
  // JPEGs without any text layer. Requires pdftoppm on PATH (poppler-utils).
  const enPhoto = renderPdfToJpegs(`${OUT_DIR}${EN_CBC.filename}`)[0];
  const scannedLabPdf = buildImagePdf([enPhoto]);
  writeFileSync(`${OUT_DIR}scanned-lab.pdf`, scannedLabPdf);
  console.log(`wrote scanned-lab.pdf (${scannedLabPdf.length} bytes)`);
  const ltPhoto = renderPdfToJpegs(`${OUT_DIR}${LT_LAB.filename}`)[0];
  writeFileSync(`${OUT_DIR}lab-photo.jpg`, ltPhoto);
  console.log(`wrote lab-photo.jpg (${ltPhoto.length} bytes)`);
}

// Importable for its builders (tests) without regenerating the fixtures.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
