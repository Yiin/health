// Fixture tests for the classifying stage (worker/classify.ts), driven
// through the real stage executor (runIngestion) against the test database.
// MinIO and Kimi are replaced by injected fakes; assertions cover both layers
// (deterministic vs Kimi fallback) and every terminal outcome.

import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";

import {
  CLASSIFY_PROMPT_V1,
  createClassifyStage,
  isWearableCsvHeader,
  parseKimiClassification,
  zipMarkers,
  type ReadOriginalRange,
} from "./classify";
import { runIngestion, stubStages } from "./ingestion";

setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LAB_PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);

const GARMIN_CSV = new TextEncoder().encode(
  "Date,Steps,Distance,Floors,Calories\n" +
    "2026-07-01,8432,6.12,3,2145\n" +
    "2026-07-02,10233,7.41,5,2301\n",
);

const APPLE_EXPORT_XML = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<!DOCTYPE HealthData [\n]>\n" +
    '<HealthData locale="lt_LT">\n' +
    ' <ExportDate value="2026-07-01 10:00:00 +0300"/>\n' +
    ' <Record type="HKQuantityTypeIdentifierStepCount" value="8432"/>\n' +
    "</HealthData>\n",
);

// Minimal 1x1 PNG header (magic + IHDR chunk start).
const RANDOM_IMAGE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0xde, 0xad, 0xbe,
  0xef,
]);

/** Deterministic pseudo-random bytes (mulberry32) — no magic, not text. */
function corruptedBytes(length: number): Uint8Array {
  let state = 0x2f6e2b1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}
const CORRUPTED = corruptedBytes(4096);

function push16(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function push32(bytes: number[], value: number): void {
  push16(bytes, value & 0xffff);
  push16(bytes, (value >>> 16) & 0xffff);
}

/** Builds a real zip (stored entries, empty content) listing `names`. */
function buildZip(names: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const body: number[] = [];
  const central: number[] = [];
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const offset = body.length;
    push32(body, 0x04034b50); // local file header
    push16(body, 20);
    push16(body, 0x0800); // UTF-8 names
    push16(body, 0); // stored
    push16(body, 0);
    push16(body, 0);
    push32(body, 0); // crc
    push32(body, 0); // compressed size
    push32(body, 0); // uncompressed size
    push16(body, nameBytes.length);
    push16(body, 0);
    body.push(...nameBytes);

    push32(central, 0x02014b50); // central directory entry
    push16(central, 20);
    push16(central, 20);
    push16(central, 0x0800);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, 0);
    push32(central, 0);
    push16(central, nameBytes.length);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, offset);
    central.push(...nameBytes);
  }
  const cdOffset = body.length;
  body.push(...central);
  push32(body, 0x06054b50); // end of central directory
  push16(body, 0);
  push16(body, 0);
  push16(body, names.length);
  push16(body, names.length);
  push32(body, central.length);
  push32(body, cdOffset);
  push16(body, 0);
  return new Uint8Array(body);
}

const TAKEOUT_ZIP = buildZip([
  "Takeout/Fit/Daily activity metrics/2026-07-01.csv",
  "Takeout/Keep/notes.json",
]);
const GARMIN_ZIP = buildZip(["DI_CONNECT/DI-Connect-Fitness/user_activity.csv"]);
const APPLE_ZIP = buildZip(["apple_health_export/export.xml"]);
const PLAIN_ZIP = buildZip(["photos/cat.jpg", "photos/dog.jpg"]);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const store = new Map<string, Uint8Array>();

const readRange: ReadOriginalRange = async (s3Key, start, end) => {
  const bytes = store.get(s3Key);
  if (!bytes) return null;
  const slice =
    start < 0
      ? bytes.subarray(Math.max(0, bytes.length + start))
      : bytes.subarray(start, end ?? bytes.length);
  return { bytes: slice, totalSize: bytes.length };
};

function kimiReply(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface Harness {
  chatStructured: ReturnType<typeof vi.fn>;
  extractFileText: ReturnType<typeof vi.fn>;
  readRangeCalls: ReturnType<typeof vi.fn>;
  run: (documentId: string) => ReturnType<typeof runIngestion>;
}

function makeHarness(): Harness {
  const chatStructured = vi.fn(async () =>
    kimiReply({
      docType: "lab_report",
      language: "lt",
      confidence: 0.97,
      summary: "Blood panel (32 analytes) from SYNLAB Lietuva, 2026-03-14.",
    }),
  );
  const extractFileText = vi.fn(async () => "CHOLESTEROL 5,2 mmol/L < 5,0");
  const readRangeCalls = vi.fn(readRange);
  const stages = {
    ...stubStages,
    classifying: createClassifyStage({
      sql,
      readRange: readRangeCalls,
      chatStructured,
      extractFileText,
    }),
  };
  return {
    chatStructured,
    extractFileText,
    readRangeCalls,
    run: (documentId) => runIngestion(sql, documentId, { stages }),
  };
}

async function insertDocument(
  filename: string,
  fixture: Uint8Array,
  opts: { contentType?: string; metadataOverrides?: object } = {},
): Promise<{ id: string; s3Key: string }> {
  const s3Key = `originals/2026/07/ab/${crypto.randomUUID()}`;
  store.set(s3Key, fixture);
  const rows = await sql<{ id: string }[]>`
    insert into documents
      (sha256, original_filename, s3_key, content_type, size_bytes, metadata_overrides)
    values (
      ${crypto.randomUUID()}, ${filename}, ${s3Key},
      ${opts.contentType ?? null}, ${fixture.length},
      ${opts.metadataOverrides ? sql.json(opts.metadataOverrides as postgres.JSONValue) : null}
    )
    returning id
  `;
  return { id: rows[0].id, s3Key };
}

async function documentRow(id: string) {
  const rows = await sql<
    {
      status: string;
      document_type: string;
      classification_confidence: number | null;
      ai_summary: string | null;
    }[]
  >`
    select status, document_type, classification_confidence::float8, ai_summary
    from documents where id = ${id}
  `;
  return rows[0];
}

async function classifyPayloadRow(id: string) {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from raw_extractions
    where document_id = ${id} and stage = 'classifying'
  `;
  return rows[0]?.payload ?? null;
}

// ---------------------------------------------------------------------------
// Acceptance fixtures
// ---------------------------------------------------------------------------

describe("classifying stage fixtures", () => {
  it("lab PDF → Kimi fallback classifies lab_report (extract path)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("kraujo-tyrimai.pdf", LAB_PDF, {
      contentType: "application/pdf",
    });

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    const doc = await documentRow(id);
    expect(doc.status).toBe("done");
    expect(doc.document_type).toBe("lab_report");
    expect(doc.classification_confidence).toBeCloseTo(0.97);
    expect(doc.ai_summary).toBe(
      "Blood panel (32 analytes) from SYNLAB Lietuva, 2026-03-14.",
    );
    // Ambiguous container → exactly one Kimi call via the files-extract path.
    expect(harness.chatStructured).toHaveBeenCalledTimes(1);
    expect(harness.extractFileText).toHaveBeenCalledTimes(1);
    const userMessage = harness.chatStructured.mock.calls[0][0].messages[1]
      .content as string;
    expect(userMessage).toContain("kraujo-tyrimai.pdf");
    expect(userMessage).toContain("CHOLESTEROL");
    const payload = await classifyPayloadRow(id);
    expect(payload).toMatchObject({
      promptVersion: CLASSIFY_PROMPT_V1,
      source: "kimi",
      docType: "lab_report",
      language: "lt",
    });
    expect(payload?.halt).toBeUndefined();
  });

  it("Garmin CSV → wearable_export, deterministically (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("activities.csv", GARMIN_CSV, {
      contentType: "text/csv",
    });

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    const doc = await documentRow(id);
    expect(doc.document_type).toBe("wearable_export");
    expect(doc.classification_confidence).toBe(1);
    expect(harness.chatStructured).not.toHaveBeenCalled();
    expect(harness.extractFileText).not.toHaveBeenCalled();
    const payload = await classifyPayloadRow(id);
    expect(payload).toMatchObject({
      promptVersion: CLASSIFY_PROMPT_V1,
      source: "deterministic",
      docType: "wearable_export",
    });
  });

  it("Google Takeout zip → takeout_archive by listing markers (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("takeout-20260701.zip", TAKEOUT_ZIP);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    expect((await documentRow(id)).document_type).toBe("takeout_archive");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("Garmin DI_CONNECT zip → wearable_export (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("garmin-export.zip", GARMIN_ZIP);

    await harness.run(id);

    expect((await documentRow(id)).document_type).toBe("wearable_export");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("Apple Health zip → apple_health_export (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("export.zip", APPLE_ZIP);

    await harness.run(id);

    expect((await documentRow(id)).document_type).toBe("apple_health_export");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("Apple export.xml → apple_health_export by content marker (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("export.xml", APPLE_EXPORT_XML);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    expect((await documentRow(id)).document_type).toBe("apple_health_export");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("random image → image by magic bytes (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("IMG_4031.png", RANDOM_IMAGE, {
      contentType: "image/png",
    });

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    expect((await documentRow(id)).document_type).toBe("image");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("corrupted file → unknown, halted to ignored (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("corrupted.bin", CORRUPTED);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "ignored",
    });
    const doc = await documentRow(id);
    expect(doc.status).toBe("ignored");
    expect(doc.document_type).toBe("unknown");
    expect(doc.classification_confidence).toBeNull();
    expect(harness.chatStructured).not.toHaveBeenCalled();
    const payload = await classifyPayloadRow(id);
    expect(payload).toMatchObject({
      promptVersion: CLASSIFY_PROMPT_V1,
      source: "deterministic",
      docType: "unknown",
      halt: { status: "ignored" },
    });
  });

  it("markerless zip → unknown → ignored, deterministically (no Kimi)", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("holiday-photos.zip", PLAIN_ZIP);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "ignored",
    });
    expect((await documentRow(id)).status).toBe("ignored");
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Kimi fallback outcomes
// ---------------------------------------------------------------------------

describe("classifying stage Kimi outcomes", () => {
  const REFERRAL_TXT = new TextEncoder().encode(
    "Siuntimas konsultacijai\n" +
      "Gydytojas: dr. Jonaitis\n" +
      "Pacientas siunčiamas kardiologo konsultacijai dėl skundų.\n",
  );

  it("confidence below 0.6 → needs_review with the best guess persisted", async () => {
    const harness = makeHarness();
    harness.chatStructured.mockResolvedValue(
      kimiReply({
        docType: "medical_doc",
        language: "lt",
        confidence: 0.4,
        summary: "Possibly a referral letter, layout unclear.",
      }),
    );
    const { id } = await insertDocument("siuntimas.txt", REFERRAL_TXT);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "needs_review",
    });
    const doc = await documentRow(id);
    expect(doc.status).toBe("needs_review");
    expect(doc.document_type).toBe("medical_doc");
    expect(doc.classification_confidence).toBeCloseTo(0.4);
    expect(doc.ai_summary).toBe("Possibly a referral letter, layout unclear.");
    expect(harness.chatStructured).toHaveBeenCalledTimes(1);
    const payload = await classifyPayloadRow(id);
    expect(payload).toMatchObject({
      source: "kimi",
      docType: "medical_doc",
      halt: { status: "needs_review" },
    });
  });

  it("Kimi 'unknown' → ignored, terminal", async () => {
    const harness = makeHarness();
    harness.chatStructured.mockResolvedValue(
      kimiReply({
        docType: "unknown",
        language: "en",
        confidence: 0.95,
        summary: "A shopping list, not a health document.",
      }),
    );
    const { id } = await insertDocument("notes.txt", REFERRAL_TXT);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "ignored",
    });
    expect((await documentRow(id)).status).toBe("ignored");
  });

  it("invalid Kimi JSON is retried exactly once (fresh call)", async () => {
    const harness = makeHarness();
    harness.chatStructured
      .mockResolvedValueOnce("this is not json")
      .mockResolvedValueOnce(
        kimiReply({
          docType: "medical_doc",
          language: "lt",
          confidence: 0.9,
          summary: "Referral letter to a cardiologist.",
        }),
      );
    const { id } = await insertDocument("siuntimas.txt", REFERRAL_TXT);

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    expect(harness.chatStructured).toHaveBeenCalledTimes(2);
    expect((await documentRow(id)).document_type).toBe("medical_doc");
  });

  it("two invalid Kimi replies fail the stage (pg-boss retries)", async () => {
    const harness = makeHarness();
    harness.chatStructured.mockResolvedValue("garbage");
    const { id } = await insertDocument("siuntimas.txt", REFERRAL_TXT);

    await expect(harness.run(id)).rejects.toThrow(
      /failed validation twice/,
    );
    expect(harness.chatStructured).toHaveBeenCalledTimes(2);
    const doc = await documentRow(id);
    expect(doc.status).toBe("classifying");
    expect(doc.document_type).toBe("unknown"); // untouched
  });

  it("ambiguous CSV without wearable headers goes to Kimi with ~200 lines", async () => {
    const harness = makeHarness();
    harness.chatStructured.mockResolvedValue(
      kimiReply({
        docType: "fit_export",
        language: "en",
        confidence: 0.88,
        summary: "Google Fit heart-rate samples.",
      }),
    );
    const lines = ["timestamp,metric,value"];
    for (let i = 0; i < 500; i += 1) {
      lines.push(`2026-07-01T10:${String(i % 60).padStart(2, "0")}:00Z,hr,6${i % 10}`);
    }
    const { id } = await insertDocument(
      "fit.csv",
      new TextEncoder().encode(lines.join("\n")),
    );

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    expect((await documentRow(id)).document_type).toBe("fit_export");
    const userMessage = harness.chatStructured.mock.calls[0][0].messages[1]
      .content as string;
    const sampleLines = userMessage.split("\n").length;
    expect(sampleLines).toBeLessThanOrEqual(210); // header + wrapper lines
    expect(harness.extractFileText).not.toHaveBeenCalled();
  });

  it("a 'Process as…' metadata override wins without sniffing or Kimi", async () => {
    const harness = makeHarness();
    const { id } = await insertDocument("mystery.dat", CORRUPTED, {
      metadataOverrides: { documentType: "lab_report" },
    });

    const outcome = await harness.run(id);

    expect(outcome).toEqual({ kind: "done" });
    const doc = await documentRow(id);
    expect(doc.document_type).toBe("lab_report");
    expect(doc.status).toBe("done");
    expect(harness.chatStructured).not.toHaveBeenCalled();
    // The original bytes were never even read.
    expect(harness.readRangeCalls).not.toHaveBeenCalled();
    const payload = await classifyPayloadRow(id);
    expect(payload).toMatchObject({
      source: "metadata_override",
      docType: "lab_report",
    });
  });

  it("missing original bytes fail the stage (retryable)", async () => {
    const harness = makeHarness();
    const s3Key = `originals/2026/07/ab/${crypto.randomUUID()}`; // never stored
    const rows = await sql<{ id: string }[]>`
      insert into documents (sha256, original_filename, s3_key, size_bytes)
      values (${crypto.randomUUID()}, 'ghost.pdf', ${s3Key}, 123)
      returning id
    `;
    const id = rows[0].id;

    await expect(harness.run(id)).rejects.toThrow(/not found or empty/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classification helpers", () => {
  it("zipMarkers maps Takeout, Apple Health and Garmin layouts", () => {
    expect(zipMarkers(["Takeout/Fit/x.csv"])?.docType).toBe("takeout_archive");
    expect(zipMarkers(["apple_health_export/export.xml"])?.docType).toBe(
      "apple_health_export",
    );
    expect(zipMarkers(["DI_CONNECT/user/x.csv"])?.docType).toBe(
      "wearable_export",
    );
    expect(zipMarkers(["random/file.txt"])).toBeNull();
    // Takeout wins when several markers are present.
    expect(
      zipMarkers(["DI_CONNECT/x", "Takeout/Fit/x.csv"])?.docType,
    ).toBe("takeout_archive");
  });

  it("isWearableCsvHeader matches date+metric shapes only", () => {
    expect(isWearableCsvHeader("Date,Steps,Calories")).toBe(true);
    expect(isWearableCsvHeader("day;sleep score;hrv")).toBe(true);
    expect(isWearableCsvHeader("Cycle start time,Strain,Recovery")).toBe(true);
    expect(isWearableCsvHeader("Analyte,Value,Unit,Reference")).toBe(false);
    expect(isWearableCsvHeader("name,address,city")).toBe(false);
  });

  it("parseKimiClassification validates the schema", () => {
    const ok = parseKimiClassification(
      JSON.stringify({
        docType: "lab_report",
        language: "lt",
        confidence: 0.9,
        summary: "x",
      }),
    );
    expect(ok).toMatchObject({ ok: true });

    expect(parseKimiClassification("nope").ok).toBe(false);
    expect(
      parseKimiClassification(
        JSON.stringify({
          docType: "spreadsheet",
          language: "lt",
          confidence: 0.9,
          summary: "x",
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseKimiClassification(
        JSON.stringify({
          docType: "lab_report",
          language: "lt",
          confidence: 1.5,
          summary: "x",
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseKimiClassification(
        JSON.stringify({
          docType: "lab_report",
          language: "lt",
          confidence: 0.9,
          summary: "  ",
        }),
      ).ok,
    ).toBe(false);
  });
});
