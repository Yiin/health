import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

import { aiInsights, documents, type InsightKind } from "../schema";
import { setupTestDb, TEST_DATABASE_URL } from "../test-utils";
import {
  registerUpload,
  searchDocuments,
  updateExtraction,
  updateStatus,
} from "./documents";

const getDb = setupTestDb();

function freshSha256(): string {
  return randomBytes(32).toString("hex");
}

// drizzle wraps driver errors in "Failed query: …"; the Postgres message
// (with the constraint name) is on .cause.
async function expectPgError(promise: Promise<unknown>, pattern: RegExp) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  const { message, cause } = error as Error & { cause?: Error };
  expect(`${message}\n${cause?.message ?? ""}`).toMatch(pattern);
}

async function insertDocument(
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  const rows = await getDb()
    .insert(documents)
    .values({
      sha256: freshSha256(),
      originalFilename: "report.pdf",
      s3Key: `originals/ab/${freshSha256()}`,
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

describe("registerUpload", () => {
  test("inserts a new document with state-machine defaults", async () => {
    const sha256 = freshSha256();
    const { document, isDuplicate } = await registerUpload(getDb(), {
      sha256,
      filename: "labs-2026-07.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
      s3Key: `originals/${sha256.slice(0, 2)}/${sha256}`,
    });

    expect(isDuplicate).toBe(false);
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.sha256).toBe(sha256);
    expect(document.originalFilename).toBe("labs-2026-07.pdf");
    expect(document.status).toBe("uploaded");
    expect(document.documentType).toBe("unknown");
    expect(document.attempts).toBe(0);
    expect(document.uploadedAt).toBeInstanceOf(Date);
  });

  test("duplicate sha256 registers once and returns the existing row", async () => {
    const sha256 = freshSha256();
    const input = {
      sha256,
      filename: "labs.pdf",
      s3Key: `originals/${sha256.slice(0, 2)}/${sha256}`,
    };

    const first = await registerUpload(getDb(), input);
    const second = await registerUpload(getDb(), {
      ...input,
      // A re-upload of the same bytes may carry a different filename; it is
      // still the same document.
      filename: "labs-renamed.pdf",
    });

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.originalFilename).toBe("labs.pdf");

    const count = await getDb().execute(
      sql`select count(*)::int as n from documents where sha256 = ${sha256}`,
    );
    expect((count as unknown as { n: number }[])[0]?.n).toBe(1);
  });

  test("the sha256 unique constraint backs the dedup", async () => {
    const sha256 = freshSha256();
    await insertDocument({ sha256 });
    await expectPgError(
      insertDocument({ sha256 }),
      /documents_sha256_unique|duplicate key/,
    );
  });
});

describe("updateStatus", () => {
  test("status transitions and stage errors persist", async () => {
    const doc = await insertDocument();

    const classifying = await updateStatus(getDb(), doc.id, "classifying");
    expect(classifying?.status).toBe("classifying");

    const stageError = { stage: "extracting", message: "kimi timeout" };
    const failed = await updateStatus(getDb(), doc.id, "failed", stageError);
    expect(failed?.status).toBe("failed");
    expect(failed?.stageError).toEqual(stageError);

    // Omitting stageError leaves the stored one untouched…
    const retrying = await updateStatus(getDb(), doc.id, "extracting");
    expect(retrying?.status).toBe("extracting");
    expect(retrying?.stageError).toEqual(stageError);

    // …and null clears it explicitly.
    const done = await updateStatus(getDb(), doc.id, "done", null);
    expect(done?.status).toBe("done");
    expect(done?.stageError).toBeNull();

    const persisted = await getDb().select().from(documents);
    expect(persisted[0]?.status).toBe("done");
  });

  test("rejects a status outside the state machine", async () => {
    const doc = await insertDocument();
    await expectPgError(
      updateStatus(getDb(), doc.id, "bogus" as never),
      /documents_status_check/,
    );
  });
});

describe("updateExtraction", () => {
  test("persists classification and extraction output", async () => {
    const doc = await insertDocument();

    const updated = await updateExtraction(getDb(), doc.id, {
      documentType: "lab_report",
      provider: "UAB Hila",
      documentDate: "2026-07-01",
      aiSummary: "Lipid panel, slightly elevated LDL.",
      extractedText: "CHOLESTEROL 5.2 mmol/L\nLDL 3.4 mmol/L",
      classificationConfidence: 0.98,
    });

    expect(updated?.documentType).toBe("lab_report");
    expect(updated?.provider).toBe("UAB Hila");
    expect(updated?.documentDate).toBe("2026-07-01");
    expect(updated?.aiSummary).toContain("LDL");
    expect(updated?.extractedText).toContain("CHOLESTEROL");
    expect(updated?.classificationConfidence).toBeCloseTo(0.98);
  });

  test("only touches the fields it is given", async () => {
    const doc = await insertDocument({
      provider: "Oura",
      documentType: "wearable_export",
    });

    const updated = await updateExtraction(getDb(), doc.id, {
      aiSummary: "Sleep and readiness export.",
    });

    expect(updated?.aiSummary).toBe("Sleep and readiness export.");
    expect(updated?.provider).toBe("Oura");
    expect(updated?.documentType).toBe("wearable_export");
  });

  test("rejects a document_type outside the enum", async () => {
    const doc = await insertDocument();
    await expectPgError(
      updateExtraction(getDb(), doc.id, { documentType: "bogus" as never }),
      /documents_document_type_check/,
    );
  });
});

describe("searchDocuments", () => {
  test("finds a document by a word present only in ai_summary", async () => {
    const doc = await insertDocument({
      extractedText: "CHOLESTEROL 5.2 mmol/L",
      aiSummary: "Patient shows mildly elevated zebrafish markers.",
    });

    const hits = await searchDocuments(getDb(), "zebrafish");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(doc.id);
    expect(hits[0]?.filename).toBe("report.pdf");
    expect(hits[0]?.summary).toContain("zebrafish");
    expect(hits[0]?.snippet).toContain("<b>zebrafish</b>");
  });

  test("finds a document by a word present only in extracted_text", async () => {
    const doc = await insertDocument({
      extractedText: "Hemoglobin 150 g/L, hematocrit 0.45",
    });

    const hits = await searchDocuments(getDb(), "hemoglobin");

    expect(hits.map((h) => h.id)).toEqual([doc.id]);
  });

  test("ranks documents with more occurrences first and honors limit", async () => {
    const frequent = await insertDocument({
      extractedText: "glucose glucose glucose fasting",
    });
    await insertDocument({ extractedText: "glucose fasting" });
    await insertDocument({ extractedText: "no matching terms here" });

    const hits = await searchDocuments(getDb(), "glucose");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe(frequent.id);

    const limited = await searchDocuments(getDb(), "glucose", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe(frequent.id);
  });

  test("returns nothing when no document matches", async () => {
    await insertDocument({ extractedText: "cholesterol panel" });
    expect(await searchDocuments(getDb(), "nonexistentterm")).toEqual([]);
  });
});

describe("migration shape", () => {
  test("creates the extracted_tsv generated column and its GIN index", async () => {
    const columns = (await getDb().execute(
      sql`select attgenerated from pg_attribute
          where attrelid = 'documents'::regclass and attname = 'extracted_tsv'`,
    )) as unknown as { attgenerated: string }[];
    // 's' = STORED generated column.
    expect(columns[0]?.attgenerated).toBe("s");

    const indexes = (await getDb().execute(
      sql`select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'documents'
            and indexname = 'documents_extracted_tsv_idx'`,
    )) as unknown as { indexname: string; indexdef: string }[];
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toMatch(/using gin/i);
  });

  test("self-referencing parent_document_id FK accepts zip children", async () => {
    const parent = await insertDocument({
      documentType: "takeout_archive",
      originalFilename: "takeout.zip",
    });
    const child = await insertDocument({
      parentDocumentId: parent.id,
      originalFilename: "Fit/Daily Metrics.csv",
    });
    expect(child.parentDocumentId).toBe(parent.id);
  });
});

describe("ai_insights", () => {
  test("inserts with defaults and typed source refs", async () => {
    const [insight] = await getDb()
      .insert(aiInsights)
      .values({ kind: "post_ingestion", bodyMd: "New lab report filed." })
      .returning();
    expect(insight?.sourceRefs).toEqual([]);
    expect(insight?.createdAt).toBeInstanceOf(Date);

    const refs = [{ kind: "document", id: insight!.id, note: "source" }];
    const [withRefs] = await getDb()
      .insert(aiInsights)
      .values({
        kind: "biomarker_trend",
        title: "LDL trending up",
        bodyMd: "LDL rose over the window.",
        window: "[2026-06-01,2026-07-01)",
        model: "kimi-k2.6",
        promptVersion: "v1",
        sourceRefs: refs,
      })
      .returning();
    expect(withRefs?.sourceRefs).toEqual(refs);
    expect(withRefs?.window).toBe("[2026-06-01,2026-07-01)");
  });

  test("rejects a kind outside the enum", async () => {
    await expectPgError(
      getDb()
        .insert(aiInsights)
        .values({ kind: "bogus" as InsightKind, bodyMd: "x" }),
      /ai_insights_kind_check/,
    );
  });
});

// The documents migration adds the biomarker_results.document_id FK only when
// that table already exists (it is owned by the parallel labs task). Prove
// the conditional path end-to-end: stub the labs table, apply every migration
// to a pristine database, and verify ON DELETE SET NULL is enforced.
describe("biomarker_results FK (conditional)", () => {
  const FK_DB = "health_test_w8_fk";

  test("adds an ON DELETE SET NULL FK when biomarker_results predates the migration", async () => {
    const adminUrl = new URL(TEST_DATABASE_URL);
    adminUrl.pathname = "/postgres";
    const fkUrl = new URL(TEST_DATABASE_URL);
    fkUrl.pathname = `/${FK_DB}`;

    const admin = postgres(adminUrl.toString(), { max: 1 });
    const migrationsFolder = fileURLToPath(
      new URL("../../../drizzle", import.meta.url),
    );

    await admin.unsafe(`drop database if exists "${FK_DB}" with (force)`);
    await admin.unsafe(`create database "${FK_DB}"`);

    const conn = postgres(fkUrl.toString(), { max: 1 });
    try {
      // Minimal stand-in for the labs domain's table.
      await conn.unsafe(`create extension if not exists pgcrypto`);
      await conn.unsafe(
        `create table biomarker_results (
             id uuid primary key default gen_random_uuid(),
             document_id uuid
           )`,
      );

      await migrate(drizzle(conn), { migrationsFolder });

      const constraints = await conn<{ conname: string }[]>`
          select conname from pg_constraint
          where conname = 'biomarker_results_document_id_documents_id_fk'
        `;
      expect(constraints).toHaveLength(1);

      const [doc] = await conn<{ id: string }[]>`
          insert into documents (sha256, original_filename, s3_key)
          values ('fk-test', 'fk.pdf', 'originals/fk/fk-test')
          returning id
        `;
      await conn`
          insert into biomarker_results (document_id) values (${doc!.id})
        `;
      await conn`delete from documents where id = ${doc!.id}`;

      const rows = await conn<{ document_id: string | null }[]>`
          select document_id from biomarker_results
        `;
      expect(rows[0]?.document_id).toBeNull();
    } finally {
      await conn.end();
      await admin.unsafe(`drop database if exists "${FK_DB}" with (force)`);
      await admin.end();
    }
  }, 60_000);
});
