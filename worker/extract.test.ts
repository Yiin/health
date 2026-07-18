// Extracting-stage dispatcher tests (worker/extract.ts): apple_health_export
// routes to the SAX parser, other document types pass through as stubs, and
// permanent input problems surface as a needs_review halt payload the stage
// executor understands. Storage is injected (openOriginal) so no MinIO is
// needed. Runs against health_test_w33 like the parser tests.

import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SMALL_EXPORT_XML } from "./apple-health/fixture";
import { APPLE_HEALTH_PROGRESS_STAGE } from "./apple-health/index";
import { createExtractStage } from "./extract";
import { stageHaltOf, type StageContext } from "./ingestion";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/health_test_w33";

const MIGRATION_LOCK_ID = 7282011; // same advisory lock as src/db/test-utils.ts

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUrl = new URL(TEST_DATABASE_URL);
  const name = adminUrl.pathname.replace(/^\//, "");
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const found =
      await admin`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) {
      await admin.unsafe(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }
  const setup = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await setup.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
    await migrate(drizzle(setup), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await setup.end();
  }
  sql = postgres(TEST_DATABASE_URL);
}, 60_000);

afterEach(async () => {
  await sql`truncate table daily_metrics, workouts, raw_extractions, documents cascade`;
});

afterAll(async () => {
  await sql?.end();
});

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

  it("passes other document types through as stubs", async () => {
    const id = await insertDocument("lab_report");
    const stage = createExtractStage({
      sql,
      openOriginal: () => {
        throw new Error("must not be called for non-apple types");
      },
    });

    const payload = await stage(ctxFor(id));
    expect(payload).toEqual({ stub: true, documentType: "lab_report" });
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
