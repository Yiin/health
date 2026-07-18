// Live Kimi smoke eval (health-etv.10) — run MANUALLY, never in CI: it spends
// real money on the Moonshot API.
//
// Ingests the synthetic samples in fixtures/health-docs/ (Lithuanian lab PDF,
// English lab PDF, wearable CSV, scanned-no-text-layer PDF) through the REAL
// pipeline stages (worker/classify.ts, worker/extract.ts, worker/normalize.ts
// — the summarizing stage is stubbed, it is out of scope for this eval) and
// prints classification + extracted records, token usage/cost, and latency for
// human review. Findings are recorded in docs/kimi-eval.md.
//
// The script is self-provisioning and idempotent against a SCRATCH database
// and bucket (both are wiped/created on each run — never point it at real
// data):
//
//   docker compose -p health-smoke up -d db minio
//   export MOONSHOT_API_KEY=...            # from the token store, never commit
//   export SMOKE_DATABASE_URL=postgres://postgres:postgres@localhost:5433/health_smoke
//   export S3_ENDPOINT=http://localhost:9000 S3_BUCKET=health-smoke \
//          S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...   # MinIO root creds
//   node --experimental-strip-types scripts/kimi-smoke.ts
//
// A machine-readable copy of the report is written to SMOKE_REPORT_PATH
// (default /tmp/kimi-smoke-report.json) — kept out of the repo on purpose.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  BIOMARKER_SEED,
  validateBiomarkerCatalog,
} from "../src/db/seed/biomarkers.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
  type KimiUsage,
} from "../src/lib/kimi/client.ts";
import { ensureBucket, putOriginal } from "../src/lib/storage.ts";
import { createClassifyStage } from "../worker/classify.ts";
import { createExtractStage } from "../worker/extract.ts";
import {
  runIngestion,
  type IngestionStage,
  type StageRunner,
} from "../worker/ingestion.ts";
import { createNormalizeStage } from "../worker/normalize.ts";
import { parseWearableCsv } from "../worker/wearable/index.ts";
// Ground truth for the two lab PDFs (shared with generate.mjs, so the
// fixtures and expectations can never drift apart).
import { EN_CBC, LT_LAB } from "../fixtures/health-docs/content.mjs";

// Mirror drizzle-kit's convenience: pick up env from .env when the shell did
// not provide it. Existing env vars win (loadEnvFile does not override).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine
}

const DATABASE_URL =
  process.env.SMOKE_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/health_smoke";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_BUCKET ??= "health-smoke";
process.env.S3_ACCESS_KEY_ID ??= process.env.MINIO_ROOT_USER ?? "";
process.env.S3_SECRET_ACCESS_KEY ??= process.env.MINIO_ROOT_PASSWORD ?? "";

const REPORT_PATH =
  process.env.SMOKE_REPORT_PATH ?? "/tmp/kimi-smoke-report.json";

// Cost model: Moonshot lists kimi-k2.6 at $0.95 / $4.00 per 1M input/output
// tokens (platform.moonshot.ai pricing, 2026-06). Output tokens INCLUDE the
// thinking model's reasoning tokens. Override via env if prices moved.
const PRICE_IN_PER_MTOK = Number(process.env.KIMI_PRICE_INPUT_PER_MTOK ?? 0.95);
const PRICE_OUT_PER_MTOK = Number(
  process.env.KIMI_PRICE_OUTPUT_PER_MTOK ?? 4.0,
);

if (!process.env.MOONSHOT_API_KEY) {
  console.error(
    "[smoke] MOONSHOT_API_KEY is not set — this eval calls the live API",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sample set + ground truth
// ---------------------------------------------------------------------------

interface ExpectedAnalyte {
  name: string;
  value: number;
  unit: string;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  flag: "high" | "low" | null;
}

interface FixtureContent {
  filename: string;
  labName: string;
  measuredOn: string;
  analytes: string[][];
}

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function parseExpected(fixture: FixtureContent): ExpectedAnalyte[] {
  return fixture.analytes.map(([name, value, unit, ref, flag]) => {
    let refLow: number | null = null;
    let refHigh: number | null = null;
    let refText: string | null = null;
    if (ref.includes("-")) {
      const [low, high] = ref.split("-");
      refLow = toNumber(low);
      refHigh = toNumber(high);
    } else if (ref.length > 0) {
      refText = ref;
    }
    return {
      name,
      value: toNumber(value),
      unit,
      refLow,
      refHigh,
      refText,
      flag: flag === "H" ? "high" : flag === "L" ? "low" : null,
    };
  });
}

interface Sample {
  file: string;
  contentType: string;
  groundTruth?: {
    labName: string;
    measuredOn: string;
    analytes: ExpectedAnalyte[];
  };
}

const FIXTURES_DIR = fileURLToPath(
  new URL("../fixtures/health-docs/", import.meta.url),
);

const SAMPLES: Sample[] = [
  {
    file: "lt-lab.pdf",
    contentType: "application/pdf",
    groundTruth: {
      labName: LT_LAB.labName,
      measuredOn: LT_LAB.measuredOn,
      analytes: parseExpected(LT_LAB as FixtureContent),
    },
  },
  {
    file: "en-cbc.pdf",
    contentType: "application/pdf",
    groundTruth: {
      labName: EN_CBC.labName,
      measuredOn: EN_CBC.measuredOn,
      analytes: parseExpected(EN_CBC as FixtureContent),
    },
  },
  { file: "wearable-garmin.csv", contentType: "text/csv" },
  { file: "scanned.pdf", contentType: "application/pdf" },
];

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

interface CallRecord {
  doc: string;
  schema: string;
  model: string;
  latencyMs: number;
  usage: KimiUsage | null;
}

const callRecords: CallRecord[] = [];
const stageRecords: { doc: string; stage: string; latencyMs: number }[] = [];
let currentDoc = "(setup)";

/** chatStructured wrapper that records per-call tokens + latency. */
async function instrumentedChat(params: ChatStructuredParams): Promise<string> {
  const started = performance.now();
  let usage: KimiUsage | null = null;
  try {
    return await chatStructured({
      ...params,
      onUsage: (u) => {
        usage = u;
      },
    });
  } finally {
    callRecords.push({
      doc: currentDoc,
      schema: params.schema.name,
      model: params.model ?? KIMI_MODELS.chat,
      latencyMs: Math.round(performance.now() - started),
      usage,
    });
  }
}

function timed(stage: IngestionStage, runner: StageRunner): StageRunner {
  return async (ctx) => {
    const started = performance.now();
    try {
      return await runner(ctx);
    } finally {
      stageRecords.push({
        doc: currentDoc,
        stage,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  };
}

function costOf(usage: KimiUsage | null): number {
  if (!usage) return 0;
  return (
    (usage.promptTokens * PRICE_IN_PER_MTOK) / 1e6 +
    (usage.completionTokens * PRICE_OUT_PER_MTOK) / 1e6
  );
}

// ---------------------------------------------------------------------------
// Scratch environment provisioning
// ---------------------------------------------------------------------------

async function ensureDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    throw new Error(`unsafe database name in SMOKE_DATABASE_URL: ${dbName}`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const existing = await admin`
      select 1 from pg_database where datname = ${dbName}
    `;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${dbName}"`);
      console.log(`[smoke] created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function migrateDatabase(): Promise<void> {
  // Dedicated connection: drizzle() MUTATES a postgres.js pool's json/jsonb
  // serializers (see worker/normalize.ts drizzleWithoutHijack), so the shared
  // pool must never be wrapped — every later sql.json() bind would crash.
  const admin = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const migrationsFolder = fileURLToPath(
      new URL("../drizzle", import.meta.url),
    );
    await migrate(drizzle(admin), { migrationsFolder });
  } finally {
    await admin.end();
  }
}

async function seedCatalog(sql: postgres.Sql): Promise<void> {
  validateBiomarkerCatalog();
  await sql.begin(async (tx) => {
    for (const b of BIOMARKER_SEED) {
      await tx`
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
}

async function resetScratchState(sql: postgres.Sql): Promise<void> {
  // Scratch eval DB: every run starts pristine — documents (cascades to
  // raw_extractions), the biomarker catalog (cascades to biomarker_results)
  // — so normalize's exact/fuzzy/llm mapping split and alias write-backs are
  // measured against a fresh catalog, not warmed by a previous run.
  await sql`truncate documents cascade`;
  await sql`truncate biomarkers cascade`;
  await seedCatalog(sql);
}

// ---------------------------------------------------------------------------
// Ground-truth comparison
// ---------------------------------------------------------------------------

interface ExtractedRow {
  name: string;
  value: number;
  unit: string;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceText?: string | null;
  flag?: string | null;
}

interface FieldDiff {
  analyte: string;
  field: string;
  expected: string;
  got: string;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
}

/** µ (U+00B5) and μ (U+03BC) are the same unit prefix — compare by meaning. */
function normalizeUnit(unit: string): string {
  return unit.replace(/[µμ]/g, "u");
}

/** Decimal commas and dots are the same number — compare by meaning. */
function normalizeNumericText(text: string): string {
  return text.replace(",", ".");
}

function compareWithGroundTruth(
  expected: ExpectedAnalyte[],
  extracted: ExtractedRow[],
): {
  matched: number;
  missing: string[];
  extra: string[];
  diffs: FieldDiff[];
} {
  const byName = new Map(
    extracted.map((row) => [row.name.trim().toLowerCase(), row] as const),
  );
  const expectedNames = new Set(
    expected.map((row) => row.name.trim().toLowerCase()),
  );
  const missing: string[] = [];
  const diffs: FieldDiff[] = [];
  let matched = 0;

  for (const want of expected) {
    const got = byName.get(want.name.trim().toLowerCase());
    if (!got) {
      missing.push(want.name);
      continue;
    }
    matched += 1;
    const diff = (field: string, expectedValue: string, gotValue: string) =>
      diffs.push({
        analyte: want.name,
        field,
        expected: expectedValue,
        got: gotValue,
      });
    if (!closeEnough(got.value, want.value)) {
      diff("value", String(want.value), String(got.value));
    }
    if (normalizeUnit(got.unit) !== normalizeUnit(want.unit)) {
      diff("unit", want.unit, got.unit);
    }
    const gotFlag = got.flag ?? null;
    if (gotFlag !== want.flag) diff("flag", String(want.flag), String(gotFlag));
    if (want.refLow !== null || want.refHigh !== null) {
      const gotLow = got.referenceLow ?? null;
      const gotHigh = got.referenceHigh ?? null;
      const lowOk =
        want.refLow !== null &&
        gotLow !== null &&
        closeEnough(gotLow, want.refLow);
      const highOk =
        want.refHigh !== null &&
        gotHigh !== null &&
        closeEnough(gotHigh, want.refHigh);
      if (!lowOk || !highOk) {
        diff(
          "reference",
          `${want.refLow}-${want.refHigh}`,
          `${gotLow}-${gotHigh}`,
        );
      }
    } else if (want.refText !== null) {
      const gotRefText = got.referenceText ?? "";
      if (
        !normalizeNumericText(gotRefText).includes(
          normalizeNumericText(want.refText),
        )
      ) {
        diff("referenceText", want.refText, gotRefText || "(none)");
      }
    }
  }

  const extra = extracted
    .map((row) => row.name)
    .filter((name) => !expectedNames.has(name.trim().toLowerCase()));
  return { matched, missing, extra, diffs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface DocReport {
  file: string;
  sha256: string;
  sizeBytes: number;
  outcome: unknown;
  finalStatus: string | null;
  stageError: unknown;
  classifyPayload: unknown;
  extractPayload: unknown;
  normalizePayload: unknown;
  groundTruthDiff?: unknown;
  wearableParse?: unknown;
}

const reports: DocReport[] = [];
const runStarted = performance.now();

const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
try {
  await ensureDatabase();
  await migrateDatabase();
  await ensureBucket();
  await resetScratchState(sql);

  for (const sample of SAMPLES) {
    currentDoc = sample.file;
    console.log(
      `\n${"=".repeat(72)}\n[smoke] ${sample.file}\n${"=".repeat(72)}`,
    );
    const bytes = readFileSync(`${FIXTURES_DIR}${sample.file}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const s3Key = await putOriginal(bytes, sha256, {
      contentType: sample.contentType,
    });

    const [{ id: documentId }] = await sql<{ id: string }[]>`
      insert into documents
        (sha256, original_filename, content_type, size_bytes, s3_key, status)
      values (
        ${sha256}, ${sample.file}, ${sample.contentType}, ${bytes.length},
        ${s3Key}, 'uploaded'
      )
      returning id
    `;
    console.log(
      `[smoke] stored ${bytes.length} bytes as ${s3Key} (document ${documentId})`,
    );

    const stages: Record<IngestionStage, StageRunner> = {
      classifying: timed(
        "classifying",
        createClassifyStage({ sql, chatStructured: instrumentedChat }),
      ),
      extracting: timed(
        "extracting",
        createExtractStage({ sql, chatStructured: instrumentedChat }),
      ),
      normalizing: timed(
        "normalizing",
        createNormalizeStage({ sql, chatStructured: instrumentedChat }),
      ),
      // Out of scope for this eval (its own stage; would add cost/latency).
      summarizing: async () => ({
        skipped: true,
        reason: "summarize not evaluated here",
      }),
    };

    let outcome: unknown;
    try {
      outcome = await runIngestion(sql, documentId, { stages });
    } catch (error) {
      // A stage throwing on a non-final attempt rethrows out of the executor —
      // record it and move on; one bad document must not kill the eval.
      outcome = {
        kind: "threw",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    console.log(`[smoke] pipeline outcome: ${JSON.stringify(outcome)}`);

    const cached = await sql<{ stage: string; payload: unknown }[]>`
      select stage, payload from raw_extractions
      where document_id = ${documentId}
    `;
    const payloadOf = (stage: string) =>
      cached.find((row) => row.stage === stage)?.payload ?? null;
    const [document] = await sql<
      { status: string; stage_error: unknown }[]
    >`select status, stage_error from documents where id = ${documentId}`;

    const report: DocReport = {
      file: sample.file,
      sha256,
      sizeBytes: bytes.length,
      outcome,
      finalStatus: document?.status ?? null,
      stageError: document?.stage_error ?? null,
      classifyPayload: payloadOf("classifying"),
      extractPayload: payloadOf("extracting"),
      normalizePayload: payloadOf("normalizing"),
    };

    // --- human review output ---------------------------------------------
    const classify = report.classifyPayload as Record<string, unknown> | null;
    if (classify) {
      console.log(
        `[classify] ${classify.docType} (source=${classify.source}` +
          `${classify.model ? `, model=${classify.model}` : ""}` +
          `${classify.confidence != null ? `, confidence=${classify.confidence}` : ""}` +
          `${classify.language ? `, language=${classify.language}` : ""})`,
      );
      if (classify.summary)
        console.log(`[classify] summary: ${classify.summary}`);
      if (classify.detail) console.log(`[classify] detail: ${classify.detail}`);
    }

    const extract = report.extractPayload as {
      model?: string;
      textChars?: number;
      attempts?: unknown[];
      extraction?: { labName?: string; biomarkers?: ExtractedRow[] };
      halt?: { status: string; reason?: string; error?: string };
      skipped?: boolean;
      documentType?: string;
    } | null;
    if (extract?.halt) {
      console.log(
        `[extract] HALT ${extract.halt.status}` +
          `${extract.halt.reason ? ` (${extract.halt.reason})` : ""}` +
          `${extract.halt.error ? `: ${extract.halt.error}` : ""}`,
      );
    }
    if (extract?.extraction) {
      const rows = extract.extraction.biomarkers ?? [];
      console.log(
        `[extract] model=${extract.model} textChars=${extract.textChars} ` +
          `lab='${extract.extraction.labName}' analytes=${rows.length}`,
      );
      console.log(`[extract] attempts: ${JSON.stringify(extract.attempts)}`);
      for (const row of rows) {
        const ref =
          row.referenceLow != null || row.referenceHigh != null
            ? `${row.referenceLow ?? ""}-${row.referenceHigh ?? ""}`
            : (row.referenceText ?? "");
        console.log(
          `  ${row.name} | ${row.value} | ${row.unit} | ref ${ref} | flag ${row.flag ?? ""}`,
        );
      }
      if (sample.groundTruth) {
        const diff = compareWithGroundTruth(sample.groundTruth.analytes, rows);
        report.groundTruthDiff = diff;
        console.log(
          `[truth] matched ${diff.matched}/${sample.groundTruth.analytes.length}` +
            `, missing ${diff.missing.length}, extra ${diff.extra.length}` +
            `, field diffs ${diff.diffs.length}`,
        );
        for (const name of diff.missing) console.log(`  MISSING: ${name}`);
        for (const name of diff.extra)
          console.log(`  EXTRA (not in fixture): ${name}`);
        for (const d of diff.diffs) {
          console.log(
            `  DIFF ${d.analyte}.${d.field}: expected ${d.expected}, got ${d.got}`,
          );
        }
      }
    }
    if (extract?.skipped) {
      console.log(
        `[extract] skipped by pipeline dispatcher (documentType=${extract.documentType})`,
      );
    }

    const normalize = report.normalizePayload as Record<string, unknown> | null;
    if (normalize && !normalize.skipped) {
      console.log(
        `[normalize] total=${normalize.total} exact=${normalize.mappedExact} ` +
          `fuzzy=${normalize.mappedFuzzy} llm=${normalize.mappedLlm} ` +
          `inserted=${normalize.inserted} skipped=${normalize.skipped}`,
      );
      if (Array.isArray(normalize.unmapped) && normalize.unmapped.length > 0) {
        console.log(`[normalize] UNMAPPED: ${normalize.unmapped.join(", ")}`);
      }
    }

    // The wearable CSV is parsed by the deterministic (non-Kimi) plugin
    // pipeline — the extraction stage dispatches it separately, so run the
    // parser directly to show what it yields.
    if (sample.file.endsWith(".csv")) {
      const parsed = await parseWearableCsv({
        filename: sample.file,
        openStream: async () => Readable.from(bytes),
      });
      report.wearableParse =
        parsed.kind === "parsed"
          ? {
              plugin: parsed.plugin,
              confidence: parsed.confidence,
              metrics: parsed.result.metrics.length,
              workouts: parsed.result.workouts.length,
              sampleMetrics: parsed.result.metrics.slice(0, 5),
            }
          : parsed;
      console.log(`[wearable] ${JSON.stringify(report.wearableParse)}`);
    }

    reports.push(report);
  }
} finally {
  await sql.end();
  currentDoc = "(done)";
}

// ---------------------------------------------------------------------------
// Totals + JSON artifact
// ---------------------------------------------------------------------------

const totalMs = Math.round(performance.now() - runStarted);
let totalPrompt = 0;
let totalCompletion = 0;
let totalCost = 0;
console.log(`\n${"=".repeat(72)}\n[smoke] Kimi calls\n${"=".repeat(72)}`);
for (const call of callRecords) {
  const cost = costOf(call.usage);
  totalPrompt += call.usage?.promptTokens ?? 0;
  totalCompletion += call.usage?.completionTokens ?? 0;
  totalCost += cost;
  console.log(
    `  ${call.doc} | ${call.schema} | ${call.model} | ` +
      `${call.latencyMs}ms | in=${call.usage?.promptTokens ?? "?"} ` +
      `out=${call.usage?.completionTokens ?? "?"} | $${cost.toFixed(4)}`,
  );
}
console.log(`\n[smoke] stage latencies`);
for (const stage of stageRecords) {
  console.log(`  ${stage.doc} | ${stage.stage} | ${stage.latencyMs}ms`);
}
console.log(
  `\n[smoke] TOTAL: ${callRecords.length} Kimi calls, ` +
    `${totalPrompt} input + ${totalCompletion} output tokens, ` +
    `~$${totalCost.toFixed(4)} (at $${PRICE_IN_PER_MTOK}/$${PRICE_OUT_PER_MTOK} per Mtok), ` +
    `${(totalMs / 1000).toFixed(1)}s wall time`,
);

const artifact = {
  generatedAt: new Date().toISOString(),
  prices: {
    inputPerMtok: PRICE_IN_PER_MTOK,
    outputPerMtok: PRICE_OUT_PER_MTOK,
  },
  totals: {
    calls: callRecords.length,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    costUsd: totalCost,
    wallMs: totalMs,
  },
  calls: callRecords,
  stages: stageRecords,
  reports,
};
writeFileSync(REPORT_PATH, JSON.stringify(artifact, null, 2));
console.log(`[smoke] full report written to ${REPORT_PATH}`);
