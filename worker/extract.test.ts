// End-to-end tests of the extracting stage (worker/extract.ts):
// - lab_report: real fixture PDFs through real unpdf text extraction, a
//   mocked Kimi (deterministic, derived from what unpdf actually extracted —
//   see mockKimi), and the real biomarker-results repo, run through
//   runIngestion together with the normalizing stage.
// - apple_health_export: routes to the SAX parser (loose export.xml or the
//   export.zip container), other document types pass through untouched, and
//   permanent input problems surface as a needs_review halt payload the stage
//   executor understands.
// Storage (readBytes/openOriginal) and Kimi are injected, so no MinIO/Kimi is
// needed; everything runs against the shared health_test database.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BIOMARKER_SEED } from "../src/db/seed/biomarkers";
import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";
import type { ChatStructuredParams } from "../src/lib/kimi/client";
import { EN_CBC, LT_LAB } from "../fixtures/health-docs/content.mjs";
import { buildImagePdf } from "../fixtures/health-docs/generate.mjs";

import { SMALL_EXPORT_XML } from "./apple-health/fixture";
import {
  APPLE_HEALTH_PROGRESS_STAGE,
  EXPORT_XML_ENTRY,
} from "./apple-health/index";
import { buildZip } from "./zip-fixture";
import {
  createExtractStage,
  EXTRACT_PROMPT_V1,
  EXTRACT_VISION_PROMPT_V1,
  MEDICAL_DOC_PROMPT_V1,
} from "./extract";
import {
  runIngestion,
  stageHaltOf,
  stubStages,
  type StageContext,
  type StageRunner,
} from "./ingestion";
import { createNormalizeStage, NORMALIZE_PROMPT_V1 } from "./normalize";
import { MAX_VISION_PAGES } from "./vision";

setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
beforeEach(async () => {
  // test-utils truncates every table after each test — reseed the catalog.
  for (const b of BIOMARKER_SEED) {
    await sql`
      insert into biomarkers
        (slug, name, aliases, category, canonical_unit, loinc_code, molar_mass_g_mol)
      values (
        ${b.slug}, ${b.name}, ${b.aliases}, ${b.category},
        ${b.canonicalUnit}, ${b.loincCode ?? null}, ${b.molarMassGMol ?? null}
      )
      on conflict (slug) do nothing
    `;
  }
});
afterAll(async () => {
  await sql.end();
});

const FIXTURES_DIR = new URL("../fixtures/health-docs/", import.meta.url);

function fixtureBytes(filename: string): Uint8Array {
  const buffer = readFileSync(new URL(filename, FIXTURES_DIR));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

interface FixtureDef {
  filename: string;
  labName: string;
  measuredOn: string;
  analytes: string[][];
}

interface RecordedCall {
  model: string | undefined;
  schemaName: string;
  userContent: unknown;
  /** True when the user message carried image parts (vision path). */
  vision: boolean;
}

function parseFixtureRef(ref: string): Record<string, unknown> {
  if (!ref) return {};
  if (ref.startsWith("<") || ref.startsWith(">")) {
    return { referenceText: ref };
  }
  const [low, high] = ref.split("-");
  return {
    referenceLow: Number(low.replace(",", ".")),
    referenceHigh: Number(high.replace(",", ".")),
  };
}

interface MockKimiOptions {
  /** slug-or-null per unmatched name for the biomarker_mapping call. */
  mappings?: Record<string, string | null>;
  /**
   * Overrides the extraction reply: called with the 1-based call number and
   * the user message; return a raw reply string, or null to fall through to
   * the fixture-derived reply.
   */
  onExtractionCall?: (callNumber: number, userContent: string) => string | null;
  /**
   * Overrides the VISION extraction reply (the user message carries image
   * parts the mock cannot inspect): 1-based call number, raw reply string or
   * null to fall through to the full-fixture reply.
   */
  onVisionCall?: (callNumber: number) => string | null;
  /** Reply for medical_doc_extraction calls (defaults to a clinic letter). */
  medicalReply?: Record<string, unknown>;
}

const DEFAULT_MEDICAL_REPLY = {
  provider: "Vilnius City Clinic",
  documentDate: "2026-02-10",
  summary: "Discharge letter documenting a routine follow-up visit.",
  keyFindings: ["Blood pressure within range", "Continue current medication"],
};

/** Fixture analyte row → lab_extraction biomarker object. */
function fixtureBiomarker(analyte: string[]): Record<string, unknown> {
  const [name, value, unit, ref, flag] = analyte;
  return {
    name,
    value: Number(value.replace(",", ".")),
    unit,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    ...parseFixtureRef(ref),
    flag: flag === "H" ? "high" : flag === "L" ? "low" : null,
  };
}

/**
 * Deterministic Kimi stand-in. For lab_extraction calls on the TEXT path it
 * returns the fixture's analytes whose names ACTUALLY appear in the extracted
 * text — analytes lost by unpdf would silently drop out of the reply and fail
 * the count assertions. For VISION calls (image parts the mock cannot see) it
 * returns the full fixture. For biomarker_mapping calls it answers from
 * `mappings`, and for medical_doc_extraction calls from `medicalReply`.
 */
function mockKimi(fixture: FixtureDef, options: MockKimiOptions = {}) {
  const calls: RecordedCall[] = [];
  const chat = async (params: ChatStructuredParams): Promise<string> => {
    const content = params.messages.at(-1)?.content;
    const vision = Array.isArray(content);
    calls.push({
      model: params.model,
      schemaName: params.schema.name,
      userContent: content,
      vision,
    });
    if (params.schema.name === "biomarker_mapping") {
      const names = [
        ...(content as string).matchAll(/- "([^"]+)" \(unit:/g),
      ].map((m) => m[1]);
      return JSON.stringify({
        mappings: names.map((name) => ({
          name,
          slug: options.mappings?.[name] ?? null,
        })),
      });
    }
    if (params.schema.name === "medical_doc_extraction") {
      return JSON.stringify(options.medicalReply ?? DEFAULT_MEDICAL_REPLY);
    }
    if (vision) {
      const override = options.onVisionCall?.(calls.length);
      if (override !== null && override !== undefined) return override;
      // The mock cannot OCR the page images — return every fixture analyte.
      return JSON.stringify({
        measuredAt: fixture.measuredOn,
        labName: fixture.labName,
        biomarkers: fixture.analytes.map(fixtureBiomarker),
      });
    }
    const userContent = content as string;
    const override = options.onExtractionCall?.(calls.length, userContent);
    if (override !== null && override !== undefined) return override;
    const biomarkers = fixture.analytes
      .filter(([name]) => userContent.includes(name))
      .map(fixtureBiomarker);
    return JSON.stringify({
      measuredAt: fixture.measuredOn,
      labName: fixture.labName,
      biomarkers,
    });
  };
  return { calls, chat };
}

async function insertLabDocument(
  fixture: FixtureDef,
  documentType = "lab_report",
): Promise<string> {
  const bytes = fixtureBytes(fixture.filename);
  const rows = await sql<{ id: string }[]>`
    insert into documents
      (sha256, original_filename, s3_key, status, document_type, size_bytes)
    values (
      ${crypto.randomUUID()}, ${fixture.filename}, 'originals//ab/fixture',
      'classifying', ${documentType}, ${bytes.length}
    )
    returning id
  `;
  // The classify stage is a stub on this branch — pre-cache its output so the
  // executor skips straight to extracting.
  await sql`
    insert into raw_extractions (document_id, stage, payload)
    values (${rows[0].id}, 'classifying', ${sql.json({ stub: true })})
  `;
  return rows[0].id;
}

function labStages(
  chat: (params: ChatStructuredParams) => Promise<string>,
  bytes: Uint8Array,
  visionOverrides: Partial<
    Pick<
      import("./extract").ExtractStageDeps,
      "rasterizePdf" | "uploadVisionImage" | "deleteVisionImage"
    >
  > = {},
): Record<string, StageRunner> {
  return {
    ...stubStages,
    extracting: createExtractStage({
      sql,
      chatStructured: chat,
      readBytes: async () => bytes,
      ...visionOverrides,
    }),
    normalizing: createNormalizeStage({ sql, chatStructured: chat }),
  };
}

/** Fake vision uploads: fake ms:// refs, recorded for assertions. */
function fakeVisionUploads() {
  const uploads: { byteLength: number; filename: string }[] = [];
  const deletes: string[] = [];
  return {
    uploads,
    deletes,
    uploadVisionImage: async (bytes: Uint8Array, filename: string) => {
      uploads.push({ byteLength: bytes.length, filename });
      return `ms://fake-${uploads.length}`;
    },
    deleteVisionImage: async (url: string) => {
      deletes.push(url);
    },
  };
}

const POPPLER_AVAILABLE = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function documentRow(id: string) {
  const rows = await sql<
    {
      status: string;
      document_type: string;
      document_date: string | null;
      provider: string | null;
      ai_summary: string | null;
      extracted_text: string | null;
      stage_error: { stage: string; message: string } | null;
    }[]
  >`
    select status, document_type, document_date::text as document_date,
           provider, ai_summary, extracted_text, stage_error
    from documents where id = ${id}
  `;
  return rows[0];
}

interface ResultRow {
  slug: string;
  value: number;
  unit: string;
  value_canonical: number | null;
  flag: string | null;
  ref_text: string | null;
  ref_low: number | null;
  ref_high: number | null;
  lab_name: string | null;
  document_id: string | null;
}

async function resultRows(): Promise<ResultRow[]> {
  return sql<ResultRow[]>`
    select b.slug, r.value::float8 as value, r.unit,
           r.value_canonical::float8 as value_canonical, r.flag,
           r.ref_text, r.ref_low::float8 as ref_low, r.ref_high::float8 as ref_high,
           r.lab_name, r.document_id
    from biomarker_results r
    join biomarkers b on b.id = r.biomarker_id
    order by b.slug
  `;
}

async function payloadOf(id: string, stage: string) {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from raw_extractions
    where document_id = ${id} and stage = ${stage}
  `;
  return rows[0]?.payload;
}

describe("lab pipeline — EN CBC fixture", () => {
  it(
    "extracts >=90% of analytes, maps, converts, and persists them",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC);
      const { calls, chat } = mockKimi(EN_CBC, {
        mappings: { Carbamide: "bun", Homocysteine: null },
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      expect(document.status).toBe("done");
      expect(document.document_date).toBe("2026-03-14");
      expect(document.provider).toBe("City Central Laboratory");
      expect(document.extracted_text).toContain("Hemoglobin");
      // Every printed analyte name survived unpdf text extraction.
      for (const [name] of EN_CBC.analytes) {
        expect(document.extracted_text).toContain(name);
      }

      const results = await resultRows();
      // 21 printed analytes minus the unmapped Homocysteine = 20 rows (95%).
      expect(results.length).toBe(20);
      expect(results.length).toBeGreaterThanOrEqual(
        Math.ceil(EN_CBC.analytes.length * 0.9),
      );
      const bySlug = new Map(results.map((r) => [r.slug, r]));
      for (const slug of [
        "wbc",
        "rbc",
        "hemoglobin",
        "hematocrit",
        "mcv",
        "mch",
        "mchc",
        "platelets",
        "rdw",
        "glucose",
        "creatinine",
        "alt",
        "tsh",
        "vitamin-d-25oh",
        "ferritin",
        "total-cholesterol",
        "hdl",
        "ldl",
        "triglycerides",
        "bun",
      ]) {
        expect(bySlug.has(slug), `missing result for ${slug}`).toBe(true);
      }

      // Unit normalization: molar-mass conversions land in canonical units.
      expect(bySlug.get("glucose")?.value).toBe(95);
      expect(bySlug.get("glucose")?.value_canonical).toBeCloseTo(5.273, 2);
      expect(bySlug.get("creatinine")?.value_canonical).toBeCloseTo(79.56, 1);
      expect(bySlug.get("tsh")?.value_canonical).toBeCloseTo(2.1, 5);
      // Fuzzy-matched ("Vitamin D (25-OH)") and LLM-mapped ("Carbamide") rows.
      expect(bySlug.get("vitamin-d-25oh")?.value_canonical).toBe(78);
      expect(bySlug.get("bun")?.value).toBe(6.1);
      // Flags + non-interval reference text survive.
      expect(bySlug.get("ldl")?.flag).toBe("high");
      expect(bySlug.get("ldl")?.ref_text).toBe("<3.0");
      expect(bySlug.get("total-cholesterol")?.ref_low).toBeNull();
      // Rows point back at their source document.
      expect(bySlug.get("hemoglobin")?.document_id).toBe(id);
      expect(bySlug.get("hemoglobin")?.lab_name).toBe(
        "City Central Laboratory",
      );

      // The confirmed LLM mapping was written back into the catalog.
      const bun = await sql<{ aliases: string[] }[]>`
        select aliases from biomarkers where slug = 'bun'
      `;
      expect(bun[0].aliases).toContain("carbamide");

      // Stage payloads are cached for audit + resume, incl. the raw reply.
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.promptVersion).toBe(EXTRACT_PROMPT_V1);
      expect(extractPayload?.model).toBe("kimi-k2.6");
      expect(typeof extractPayload?.raw).toBe("string");
      expect(
        (extractPayload?.extraction as { biomarkers: unknown[] }).biomarkers,
      ).toHaveLength(21);
      const normalizePayload = await payloadOf(id, "normalizing");
      expect(normalizePayload?.promptVersion).toBe(NORMALIZE_PROMPT_V1);
      expect(normalizePayload?.inserted).toBe(20);
      expect(normalizePayload?.unmapped).toEqual(["Homocysteine"]);
      expect(normalizePayload?.mappedExact).toBe(19);
      expect(normalizePayload?.mappedFuzzy).toBe(0);
      expect(normalizePayload?.mappedLlm).toBe(1);

      // One extraction call + one mapping call, both on the standard model.
      expect(calls.map((c) => c.schemaName)).toEqual([
        "lab_extraction",
        "biomarker_mapping",
      ]);
      expect(calls.every((c) => c.model === "kimi-k2.6")).toBe(true);
    },
  );

  it(
    "re-running a done document is a no-op (cache + dedup, no new Kimi calls)",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC);
      const { calls, chat } = mockKimi(EN_CBC, {
        mappings: { Carbamide: "bun", Homocysteine: null },
      });
      const bytes = fixtureBytes(EN_CBC.filename);
      await runIngestion(sql, id, { stages: labStages(chat, bytes) });
      expect((await resultRows()).length).toBe(20);

      // The retry endpoint resets needs_review/failed to uploaded; the same
      // reset on a done document must not redo any work.
      await sql`update documents set status = 'uploaded' where id = ${id}`;
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, bytes),
      });

      expect(outcome).toEqual({ kind: "done" });
      expect((await resultRows()).length).toBe(20);
      expect(calls.length).toBe(2); // unchanged — every stage was cached
      const aliases = await sql<{ aliases: string[] }[]>`
        select aliases from biomarkers where slug = 'bun'
      `;
      expect(aliases[0].aliases.filter((a) => a === "carbamide")).toHaveLength(
        1,
      );
    },
  );
});

describe("lab pipeline — Lithuanian fixture", () => {
  it(
    "extracts every analyte (LT aliases, decimal commas, diacritics)",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(LT_LAB);
      const { calls, chat } = mockKimi(LT_LAB);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(LT_LAB.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      expect(document.document_date).toBe("2026-04-02");
      expect(document.provider).toBe("SYNLAB Lietuva");
      // Diacritics survive unpdf end-to-end.
      expect(document.extracted_text).toContain("Gliukozė");
      expect(document.extracted_text).toContain("Mėginio data");

      const results = await resultRows();
      expect(results.length).toBe(LT_LAB.analytes.length); // all 11
      const bySlug = new Map(results.map((r) => [r.slug, r]));
      expect(bySlug.get("glucose")?.value_canonical).toBeCloseTo(5.4, 5);
      expect(bySlug.get("creatinine")?.value_canonical).toBe(78);
      expect(bySlug.get("wbc")?.value).toBe(7.2);
      expect(bySlug.get("calcium")?.value).toBe(2.35);
      // TTG fuzzy-matched tsh; its mTV/L unit has no conversion path, so only
      // the as-reported value is stored (value_canonical null — never guessed).
      expect(bySlug.get("tsh")?.value).toBe(1.8);
      expect(bySlug.get("tsh")?.unit).toBe("mTV/L");
      expect(bySlug.get("tsh")?.value_canonical).toBeNull();

      // No analyte needed the LLM mapping fallback.
      expect(calls.map((c) => c.schemaName)).toEqual(["lab_extraction"]);
      const normalizePayload = await payloadOf(id, "normalizing");
      expect(normalizePayload?.inserted).toBe(LT_LAB.analytes.length);
      expect(normalizePayload?.unmapped).toEqual([]);
    },
  );
});

describe("lab pipeline — extraction failure paths", () => {
  it(
    "invalid model JSON: exactly one retry, expert escalation, then needs_review",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC);
      const { calls, chat } = mockKimi(EN_CBC, {
        onExtractionCall: () => "{this is not valid json",
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({
        kind: "halted",
        stage: "extracting",
        status: "needs_review",
      });
      // k2.6 → k2.6 retry (error appended) → k3 escalation; then it stops.
      expect(calls.map((c) => c.model)).toEqual([
        "kimi-k2.6",
        "kimi-k2.6",
        "kimi-k3",
      ]);
      expect(calls[1].userContent).toContain("failed validation");

      const document = await documentRow(id);
      expect(document.status).toBe("needs_review");
      expect(document.stage_error?.stage).toBe("extracting");
      expect(document.stage_error?.message).toContain("failed validation");
      expect(await resultRows()).toHaveLength(0);
      // The halt payload (with the attempt log) is cached for audit.
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.halt).toMatchObject({
        status: "needs_review",
        reason: "extraction validation failed",
      });
      expect(extractPayload?.attempts).toHaveLength(3);
    },
  );

  it(
    "expert model rescues an extraction the standard model garbled twice",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC);
      const { calls, chat } = mockKimi(EN_CBC, {
        mappings: { Carbamide: "bun", Homocysteine: null },
        onExtractionCall: (callNumber) =>
          callNumber <= 2 ? "sure, here is your JSON: {...}" : null,
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      expect(calls.map((c) => c.model).slice(0, 3)).toEqual([
        "kimi-k2.6",
        "kimi-k2.6",
        "kimi-k3",
      ]);
      expect((await resultRows()).length).toBe(20);
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.model).toBe("kimi-k3");
    },
  );

  it(
    "implausibly few analytes for the text volume escalates to the expert",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC);
      const { calls, chat } = mockKimi(EN_CBC, {
        mappings: { Carbamide: "bun", Homocysteine: null },
        onExtractionCall: (callNumber) =>
          callNumber === 1
            ? JSON.stringify({
                measuredAt: EN_CBC.measuredOn,
                labName: EN_CBC.labName,
                biomarkers: [
                  {
                    name: "Hemoglobin",
                    value: 14.2,
                    unit: "g/dL",
                    referenceLow: 12.0,
                    referenceHigh: 16.0,
                    referenceText: null,
                    flag: null,
                  },
                ],
              })
            : null,
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      // No same-model retry for a VALID reply — straight to the expert.
      expect(calls.map((c) => c.model).slice(0, 2)).toEqual([
        "kimi-k2.6",
        "kimi-k3",
      ]);
      expect((await resultRows()).length).toBe(20);
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.model).toBe("kimi-k3");
      expect(extractPayload?.attempts).toMatchObject([
        { model: "kimi-k2.6", ok: true },
        { model: "kimi-k3", ok: true, escalatedForFew: true },
      ]);
    },
  );

  it(
    "vision extraction failing validation on every model halts in needs_review",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...EN_CBC, filename: "scanned-lab.pdf" };
      const id = await insertLabDocument(fixture);
      const { uploads, deletes, ...vision } = fakeVisionUploads();
      const { calls, chat } = mockKimi(fixture, {
        onVisionCall: () => "{this is not valid json",
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("scanned-lab.pdf"), {
          rasterizePdf: async () => ({
            kind: "ok",
            pages: [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
            pageCount: 1,
          }),
          ...vision,
        }),
      });

      expect(outcome).toEqual({
        kind: "halted",
        stage: "extracting",
        status: "needs_review",
      });
      // k2.6 → k2.6 retry (error appended) → k3 escalation; then it stops.
      expect(calls.map((c) => c.model)).toEqual([
        "kimi-k2.6",
        "kimi-k2.6",
        "kimi-k3",
      ]);
      expect(calls.every((c) => c.vision)).toBe(true);
      // The retry note rides along as an extra text part after the images.
      const retryContent = calls[1].userContent as { type: string; text?: string }[];
      expect(
        retryContent.some(
          (part) => part.type === "text" && part.text?.includes("failed validation"),
        ),
      ).toBe(true);

      const document = await documentRow(id);
      expect(document.status).toBe("needs_review");
      expect(document.stage_error?.stage).toBe("extracting");
      expect(document.stage_error?.message).toContain("failed validation");
      expect(await resultRows()).toHaveLength(0);
      // The uploaded page was cleaned up even though extraction failed.
      expect(deletes).toEqual(["ms://fake-1"]);
      expect(uploads).toHaveLength(1);
    },
  );

  it(
    "a PDF poppler cannot read halts needs_review (rasterization failed)",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...EN_CBC, filename: "scanned-lab.pdf" };
      const id = await insertLabDocument(fixture);
      const { calls, chat } = mockKimi(fixture);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("scanned-lab.pdf"), {
          rasterizePdf: async () => ({ kind: "failed", detail: "boom" }),
        }),
      });

      expect(outcome).toEqual({
        kind: "halted",
        stage: "extracting",
        status: "needs_review",
      });
      expect(calls).toHaveLength(0);
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.halt).toMatchObject({
        status: "needs_review",
        reason: "rasterization failed",
      });
    },
  );

  it(
    "non-lab documents pass through untouched (stub behavior)",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC, "medical_doc");
      const { calls, chat } = mockKimi(EN_CBC);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      expect(calls).toHaveLength(0);
      expect(await resultRows()).toHaveLength(0);
      expect(await payloadOf(id, "extracting")).toMatchObject({
        skipped: true,
        documentType: "medical_doc",
      });
      expect(await payloadOf(id, "normalizing")).toMatchObject({
        skipped: true,
        documentType: "medical_doc",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Vision path (health-etv.11): scanned PDFs are rasterized with poppler and
// re-read through Kimi vision with the SAME biomarker schema; image files go
// lab-first and fall through to the medical-document extraction; medical_doc
// scans go straight to medical vision. Kimi and the uploads are mocked; the
// rasterizer is real poppler where marked (skipped without poppler-utils).
// ---------------------------------------------------------------------------

describe("lab pipeline — vision path", () => {
  it(
    "a scanned (image-only) lab PDF produces the same biomarker rows as text",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...EN_CBC, filename: "scanned-lab.pdf" };
      const id = await insertLabDocument(fixture);
      const { uploads, deletes, ...vision } = fakeVisionUploads();
      const { calls, chat } = mockKimi(fixture, {
        mappings: { Carbamide: "bun", Homocysteine: null },
      });
      // Real poppler rasterization of the real fixture — the injected seams
      // are only the Kimi uploads.
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("scanned-lab.pdf"), vision),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      expect(document.status).toBe("done");
      expect(document.document_date).toBe("2026-03-14");
      expect(document.provider).toBe("City Central Laboratory");
      // A scanned PDF has no text layer to persist.
      expect(document.extracted_text).toBeNull();

      // Same rows as the text path: 21 analytes minus unmapped Homocysteine.
      const results = await resultRows();
      expect(results.length).toBe(20);
      const bySlug = new Map(results.map((r) => [r.slug, r]));
      expect(bySlug.get("hemoglobin")?.value).toBe(14.2);
      expect(bySlug.get("glucose")?.value_canonical).toBeCloseTo(5.273, 2);
      expect(bySlug.get("ldl")?.flag).toBe("high");
      expect(bySlug.get("hemoglobin")?.document_id).toBe(id);

      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.promptVersion).toBe(EXTRACT_VISION_PROMPT_V1);
      expect(extractPayload?.vision).toBe(true);
      expect(extractPayload?.pageCount).toBe(1);
      expect(
        (extractPayload?.extraction as { biomarkers: unknown[] }).biomarkers,
      ).toHaveLength(21);
      const normalizePayload = await payloadOf(id, "normalizing");
      expect(normalizePayload?.inserted).toBe(20);

      // One vision lab_extraction call + one text mapping call.
      expect(calls.map((c) => c.schemaName)).toEqual([
        "lab_extraction",
        "biomarker_mapping",
      ]);
      expect(calls[0].vision).toBe(true);
      // The single rasterized page was uploaded and cleaned up afterwards.
      expect(uploads.map((u) => u.filename)).toEqual([
        "scanned-lab.pdf.page-1.jpg",
      ]);
      expect(deletes).toEqual(["ms://fake-1"]);
    },
  );

  it.skipIf(!POPPLER_AVAILABLE)(
    `a >${MAX_VISION_PAGES}-page scan halts in needs_review without calling Kimi`,
    { timeout: 30_000 },
    async () => {
      const fixture = { ...EN_CBC, filename: "scanned-lab.pdf" };
      const id = await insertLabDocument(fixture);
      const photo = fixtureBytes("lab-photo.jpg");
      const jpeg = Buffer.from(photo.buffer, photo.byteOffset, photo.length);
      const bigScan = buildImagePdf(
        Array.from({ length: MAX_VISION_PAGES + 1 }, () => jpeg),
      );
      const { calls, chat } = mockKimi(fixture);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, new Uint8Array(bigScan)),
      });

      expect(outcome).toEqual({
        kind: "halted",
        stage: "extracting",
        status: "needs_review",
      });
      expect(calls).toHaveLength(0);
      const document = await documentRow(id);
      expect(document.status).toBe("needs_review");
      expect(document.stage_error?.message).toContain(
        `${MAX_VISION_PAGES + 1} pages`,
      );
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.halt).toMatchObject({
        status: "needs_review",
        reason: "too many pages",
      });
    },
  );

  it(
    "a JPG photo of a lab report (document_type image) yields biomarker rows",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...LT_LAB, filename: "lab-photo.jpg" };
      const id = await insertLabDocument(fixture, "image");
      const { uploads, deletes, ...vision } = fakeVisionUploads();
      const { calls, chat } = mockKimi(fixture);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("lab-photo.jpg"), {
          // A single image must never touch the rasterizer.
          rasterizePdf: async () => {
            throw new Error("rasterize must not run for image files");
          },
          ...vision,
        }),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      // The image proved to be a lab report: the type is promoted so the
      // normalizing stage persisted its rows.
      expect(document.document_type).toBe("lab_report");
      expect(document.document_date).toBe("2026-04-02");
      expect(document.provider).toBe("SYNLAB Lietuva");

      const results = await resultRows();
      expect(results.length).toBe(LT_LAB.analytes.length); // all 11
      const bySlug = new Map(results.map((r) => [r.slug, r]));
      expect(bySlug.get("glucose")?.value_canonical).toBeCloseTo(5.4, 5);
      expect(bySlug.get("hemoglobin")?.document_id).toBe(id);

      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.vision).toBe(true);
      expect(extractPayload?.promotedFrom).toBe("image");
      expect(calls.map((c) => c.schemaName)).toEqual(["lab_extraction"]);
      // The image itself was uploaded verbatim (no rasterization).
      expect(uploads.map((u) => u.filename)).toEqual(["lab-photo.jpg"]);
      expect(deletes).toEqual(["ms://fake-1"]);
      const normalizePayload = await payloadOf(id, "normalizing");
      expect(normalizePayload?.inserted).toBe(LT_LAB.analytes.length);
    },
  );

  it(
    "an image with no analytes falls through to medical-doc extraction",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...LT_LAB, filename: "lab-photo.jpg" };
      const id = await insertLabDocument(fixture, "image");
      const { deletes, ...vision } = fakeVisionUploads();
      const { calls, chat } = mockKimi(fixture, {
        onVisionCall: (callNumber) =>
          callNumber === 1
            ? JSON.stringify({
                measuredAt: fixture.measuredOn,
                labName: "",
                biomarkers: [],
              })
            : null,
      });
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("lab-photo.jpg"), vision),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      expect(document.document_type).toBe("medical_doc");
      expect(document.provider).toBe("Vilnius City Clinic");
      expect(document.document_date).toBe("2026-02-10");
      expect(document.ai_summary).toContain("Discharge letter");
      expect(await resultRows()).toHaveLength(0);

      // Lab first, then the medical extraction — both vision calls.
      expect(calls.map((c) => c.schemaName)).toEqual([
        "lab_extraction",
        "medical_doc_extraction",
      ]);
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.promptVersion).toBe(MEDICAL_DOC_PROMPT_V1);
      expect(extractPayload?.promotedFrom).toBe("image");
      expect(
        (extractPayload?.medicalDoc as { keyFindings: string[] }).keyFindings,
      ).toHaveLength(2);
      // Nothing for the normalizing stage on a medical_doc.
      expect(await payloadOf(id, "normalizing")).toMatchObject({
        skipped: true,
        documentType: "medical_doc",
      });
      expect(deletes.length).toBe(2); // one upload per flow, both cleaned
    },
  );

  it(
    "a scanned medical_doc PDF goes straight to medical vision (no lab call)",
    { timeout: 30_000 },
    async () => {
      const fixture = { ...EN_CBC, filename: "scanned-lab.pdf" };
      const id = await insertLabDocument(fixture, "medical_doc");
      const { uploads, deletes, ...vision } = fakeVisionUploads();
      const { calls, chat } = mockKimi(fixture);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes("scanned-lab.pdf"), {
          rasterizePdf: async () => ({
            kind: "ok",
            pages: [
              new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
              new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            ],
            pageCount: 2,
          }),
          ...vision,
        }),
      });

      expect(outcome).toEqual({ kind: "done" });
      const document = await documentRow(id);
      expect(document.document_type).toBe("medical_doc");
      expect(document.provider).toBe("Vilnius City Clinic");
      expect(document.document_date).toBe("2026-02-10");
      expect(document.ai_summary).toContain("Discharge letter");
      expect(await resultRows()).toHaveLength(0);

      expect(calls.map((c) => c.schemaName)).toEqual([
        "medical_doc_extraction",
      ]);
      // Both rasterized pages were uploaded, in order, then cleaned up.
      expect(uploads.map((u) => u.filename)).toEqual([
        "scanned-lab.pdf.page-1.jpg",
        "scanned-lab.pdf.page-2.jpg",
      ]);
      expect(deletes).toEqual(["ms://fake-1", "ms://fake-2"]);
      const extractPayload = await payloadOf(id, "extracting");
      expect(extractPayload?.promptVersion).toBe(MEDICAL_DOC_PROMPT_V1);
      expect(extractPayload?.pageCount).toBe(2);
    },
  );

  it(
    "a text-readable medical_doc PDF is skipped without calling Kimi",
    { timeout: 30_000 },
    async () => {
      const id = await insertLabDocument(EN_CBC, "medical_doc");
      const { calls, chat } = mockKimi(EN_CBC);
      const outcome = await runIngestion(sql, id, {
        stages: labStages(chat, fixtureBytes(EN_CBC.filename)),
      });

      expect(outcome).toEqual({ kind: "done" });
      expect(calls).toHaveLength(0);
      expect(await payloadOf(id, "extracting")).toMatchObject({
        skipped: true,
        documentType: "medical_doc",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Dispatcher tests: apple_health_export routes to the SAX parser, unhandled
// document types pass through untouched, and permanent input problems surface
// as a needs_review halt payload the stage executor understands. Storage is
// injected (openOriginal) so no MinIO is needed.
// ---------------------------------------------------------------------------

async function insertDocument(
  documentType: string,
  s3Key = "originals/ab/cdef/export.xml",
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents (sha256, original_filename, s3_key, document_type)
    values (${crypto.randomUUID()}, 'export.xml', ${s3Key}, ${documentType})
    returning id
  `;
  return rows[0].id;
}

function ctxFor(documentId: string): StageContext {
  return {
    documentId,
    sha256: "deadbeef",
    originalFilename: "export.xml",
    attempt: 1,
  };
}

const SMALL_XML_STREAM = () => Promise.resolve(Readable.from([SMALL_EXPORT_XML]));

describe("createExtractStage", () => {
  it("parses an apple_health_export document into metrics + workouts", async () => {
    const id = await insertDocument("apple_health_export");
    const stage = createExtractStage({ sql, openOriginal: SMALL_XML_STREAM });

    const payload = await stage(ctxFor(id));

    expect(payload).toMatchObject({
      documentType: "apple_health_export",
      metrics: 9,
      workouts: 2,
    });
    expect(stageHaltOf(payload)).toBeNull();

    const metrics = await sql<{ count: number }[]>`
      select count(*)::int as count from daily_metrics where source = 'apple_health'
    `;
    expect(metrics[0].count).toBe(9);
    const workouts = await sql<{ count: number }[]>`
      select count(*)::int as count from workouts where source = 'apple_health'
    `;
    expect(workouts[0].count).toBe(2);
    const checkpoint = await sql<{ stage: string }[]>`
      select stage from raw_extractions where document_id = ${id}
    `;
    expect(checkpoint.map((r) => r.stage)).toEqual([APPLE_HEALTH_PROGRESS_STAGE]);
  });

  it("walks an Apple export.zip through the full pipeline to done", async () => {
    const zip = buildZip([
      { name: "apple_health_export", data: Buffer.alloc(0), directory: true },
      { name: EXPORT_XML_ENTRY, data: Buffer.from(SMALL_EXPORT_XML) },
      {
        name: "apple_health_export/export_cda.xml",
        data: Buffer.from("<ClinicalDocument/>"),
      },
    ]);
    const rows = await sql<{ id: string }[]>`
      insert into documents
        (sha256, original_filename, s3_key, document_type, size_bytes)
      values (
        ${crypto.randomUUID()}, 'export.zip', 'originals/ab/cdef/export.zip',
        'apple_health_export', ${zip.length}
      )
      returning id
    `;
    const id = rows[0].id;
    await sql`
      insert into raw_extractions (document_id, stage, payload)
      values (${id}, 'classifying', ${sql.json({ stub: true })})
    `;

    const outcome = await runIngestion(sql, id, {
      stages: {
        ...stubStages,
        extracting: createExtractStage({
          sql,
          openOriginal: () => Promise.resolve(Readable.from([zip])),
        }),
      },
    });

    expect(outcome).toEqual({ kind: "done" });
    const doc = await sql<{ status: string }[]>`
      select status from documents where id = ${id}
    `;
    expect(doc[0].status).toBe("done");
    expect(await payloadOf(id, "extracting")).toMatchObject({
      documentType: "apple_health_export",
      metrics: 9,
      workouts: 2,
    });
    const metrics = await sql<{ count: number }[]>`
      select count(*)::int as count from daily_metrics where source = 'apple_health'
    `;
    expect(metrics[0].count).toBe(9);
    const workouts = await sql<{ count: number }[]>`
      select count(*)::int as count from workouts where source = 'apple_health'
    `;
    expect(workouts[0].count).toBe(2);
  });

  it("halts needs_review on malformed XML", async () => {
    const id = await insertDocument("apple_health_export");
    const stage = createExtractStage({
      sql,
      openOriginal: () =>
        Promise.resolve(Readable.from(["<HealthData><Record</HealthData>"])),
    });

    const payload = await stage(ctxFor(id));
    const halt = stageHaltOf(payload);
    expect(halt?.status).toBe("needs_review");
    expect(halt?.reason).toMatch(/malformed XML/);
  });

  it("passes unhandled document types through untouched", async () => {
    const id = await insertDocument("medical_doc");
    const stage = createExtractStage({
      sql,
      openOriginal: () => {
        throw new Error("must not be called for unhandled types");
      },
    });

    const payload = await stage(ctxFor(id));
    expect(payload).toEqual({ skipped: true, documentType: "medical_doc" });
  });

  it("routes wearable_export documents through the CSV parser plugins", async () => {
    const id = await insertDocument("wearable_export");
    const csv = fixtureBytes("wearable-garmin.csv");
    const stage = createExtractStage({
      sql,
      openOriginal: () => Promise.resolve(Readable.from([Buffer.from(csv)])),
    });

    const payload = await stage({
      documentId: id,
      sha256: "deadbeef",
      originalFilename: "wearable-garmin.csv",
      attempt: 1,
    });

    expect(payload).toMatchObject({
      documentType: "wearable_export",
      plugin: "garmin",
    });
    expect(stageHaltOf(payload)).toBeNull();

    const [steps] = await sql<{ value: number }[]>`
      select value::float8 as value from daily_metrics
      where source = 'garmin' and metric = 'steps' and metric_on = '2024-03-01'
    `;
    expect(steps?.value).toBe(9234);
  });

  it("halts a wearable_export no plugin claims in needs_review", async () => {
    const id = await insertDocument("wearable_export");
    const stage = createExtractStage({
      sql,
      openOriginal: () =>
        Promise.resolve(Readable.from(["colour,shape\nred,circle\n"])),
    });

    const payload = await stage(ctxFor(id));
    const halt = stageHaltOf(payload);
    expect(halt?.status).toBe("needs_review");
  });

  it("throws when the original is missing from storage (transient)", async () => {
    const id = await insertDocument("apple_health_export");
    const stage = createExtractStage({
      sql,
      openOriginal: () => Promise.resolve(null),
    });

    await expect(stage(ctxFor(id))).rejects.toThrow(/missing from storage/);
  });
});
