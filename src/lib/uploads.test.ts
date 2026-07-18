import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getSqlClient } from "@/db";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";
import { getBoss, stopBoss } from "@/lib/queue";

import {
  contentTypeForFilename,
  formatBytes,
  maxUploadBytes,
  resetDocumentForRetry,
  UPLOAD_MAX_BYTES_DEFAULT,
} from "./uploads";

// The retry path (app pool + pg-boss) reads DATABASE_URL; point it at the
// test database before anything lazily initializes.
process.env.DATABASE_URL = TEST_DATABASE_URL;

setupTestDb();

describe("contentTypeForFilename", () => {
  it("maps every allowed top-level type", () => {
    expect(contentTypeForFilename("labs.pdf")).toBe("application/pdf");
    expect(contentTypeForFilename("fit.csv")).toBe("text/csv");
    expect(contentTypeForFilename("export.xml")).toBe("application/xml");
    expect(contentTypeForFilename("takeout.zip")).toBe("application/zip");
    expect(contentTypeForFilename("scan.png")).toBe("image/png");
    expect(contentTypeForFilename("scan.jpg")).toBe("image/jpeg");
    expect(contentTypeForFilename("scan.jpeg")).toBe("image/jpeg");
    expect(contentTypeForFilename("scan.webp")).toBe("image/webp");
    expect(contentTypeForFilename("notes.txt")).toBe("text/plain");
    expect(contentTypeForFilename("data.json")).toBe("application/json");
  });

  it("is case-insensitive and uses the last extension", () => {
    expect(contentTypeForFilename("LABS.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("archive.tar.zip")).toBe("application/zip");
  });

  it("rejects everything else", () => {
    expect(contentTypeForFilename("evil.exe")).toBeNull();
    expect(contentTypeForFilename("archive.tar.gz")).toBeNull();
    expect(contentTypeForFilename("no-extension")).toBeNull();
    expect(contentTypeForFilename(".pdf")).toBe("application/pdf");
  });
});

describe("maxUploadBytes", () => {
  it("defaults to 2 GiB and honors the env override", () => {
    delete process.env.UPLOAD_MAX_BYTES;
    expect(maxUploadBytes()).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    expect(UPLOAD_MAX_BYTES_DEFAULT).toBe(2 * 1024 ** 3);

    process.env.UPLOAD_MAX_BYTES = "1024";
    expect(maxUploadBytes()).toBe(1024);

    process.env.UPLOAD_MAX_BYTES = "garbage";
    expect(maxUploadBytes()).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    delete process.env.UPLOAD_MAX_BYTES;
  });
});

describe("formatBytes", () => {
  it("renders the limit in human units", () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GB");
    expect(formatBytes(1024)).toBe("1 KB");
  });
});

// ---------------------------------------------------------------------------
// resetDocumentForRetry (DB + pg-boss): besides resetting the status, a retry
// must invalidate the cached extracting/normalizing stage payloads — the
// executor would otherwise resume from the very payload that produced the
// failure (a scanned lab report halted before the vision path must re-extract
// on retry). The classifying cache survives unless a "Process as…" hint asks
// for re-classification.
// ---------------------------------------------------------------------------

describe("resetDocumentForRetry", () => {
  beforeAll(async () => {
    await getBoss();
  }, 60_000);

  afterEach(async () => {
    // test-utils truncates only the public schema; job rows would leak.
    await getSqlClient().unsafe("delete from pgboss.job");
  });

  afterAll(async () => {
    await stopBoss();
  });

  async function insertDocumentWithCache(
    status: "failed" | "needs_review" | "done",
  ): Promise<string> {
    const sql = getSqlClient();
    const rows = await sql<{ id: string }[]>`
      insert into documents (sha256, original_filename, s3_key, status, document_type)
      values (${crypto.randomUUID()}, 'scan.pdf', 'originals//ab/fixture', ${status}, 'lab_report')
      returning id
    `;
    const id = rows[0].id;
    for (const stage of ["classifying", "extracting", "normalizing"]) {
      // Bound as text + explicit cast: once resetDocumentForRetry wraps this
      // pool in drizzle, the pool's jsonb serializers are hijacked and
      // sql.json() binds break (drizzleWithoutHijack in worker/normalize.ts
      // documents the whole dance).
      await sql`
        insert into raw_extractions (document_id, stage, payload)
        values (${id}, ${stage}, ${JSON.stringify({ stub: true })}::jsonb)
      `;
    }
    return id;
  }

  async function cachedStages(id: string): Promise<string[]> {
    const rows = await getSqlClient()<{ stage: string }[]>`
      select stage from raw_extractions where document_id = ${id} order by stage
    `;
    return rows.map((row) => row.stage);
  }

  it("drops the extracting/normalizing cache but keeps classifying", async () => {
    const id = await insertDocumentWithCache("needs_review");

    const outcome = await resetDocumentForRetry(id);

    expect(outcome.kind).toBe("retried");
    expect(await cachedStages(id)).toEqual(["classifying"]);
    const rows = await getSqlClient()<{ status: string }[]>`
      select status from documents where id = ${id}
    `;
    expect(rows[0].status).toBe("uploaded");
  });

  it("a 'Process as…' hint also drops classifying so the hint is honored", async () => {
    const id = await insertDocumentWithCache("failed");

    const outcome = await resetDocumentForRetry(id, {
      documentType: "medical_doc",
    });

    expect(outcome.kind).toBe("retried");
    expect(await cachedStages(id)).toEqual([]);
    const rows = await getSqlClient()<
      { metadata_overrides: { documentType?: string } | null }[]
    >`
      select metadata_overrides from documents where id = ${id}
    `;
    expect(rows[0].metadata_overrides?.documentType).toBe("medical_doc");
  });

  it("refuses non-terminal statuses and leaves the cache untouched", async () => {
    const id = await insertDocumentWithCache("done");

    const outcome = await resetDocumentForRetry(id);

    expect(outcome.kind).toBe("not_retryable");
    expect(await cachedStages(id)).toEqual([
      "classifying",
      "extracting",
      "normalizing",
    ]);
  });
});
