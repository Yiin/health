import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSqlClient } from "@/db";
import {
  registerUpload,
  updateMetadataOverrides,
  updateStatus,
} from "@/db/repos/documents";
import { documents, rawExtractions, type DocumentStatus } from "@/db/schema";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";
import { getBoss, stopBoss } from "@/lib/queue";

import { runIngestion } from "../../../../../../worker/ingestion";

import { POST } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

function freshSha256(): string {
  return randomBytes(32).toString("hex");
}

const LEGACY_STAGES = ["classifying", "extracting", "normalizing"] as const;

/**
 * Registers a document in the given status, seeded with the full set of
 * cached stage payloads (as a completed pipeline run would leave behind).
 * The payloads carry a `legacy` marker so tests can tell stale cache rows
 * apart from freshly written ones.
 */
async function insertProcessedDocument(status: DocumentStatus, attempts = 0) {
  const sha256 = freshSha256();
  const { document } = await registerUpload(getDb(), {
    sha256,
    filename: "labs.pdf",
    s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
  });
  if (attempts > 0) {
    await getDb()
      .update(documents)
      .set({ attempts })
      .where(eq(documents.id, document.id));
  }
  const updated = await updateStatus(
    getDb(),
    document.id,
    status,
    status === "failed"
      ? { stage: "extracting", message: "kimi timeout" }
      : null,
  );
  for (const stage of LEGACY_STAGES) {
    await getDb()
      .insert(rawExtractions)
      .values({ documentId: document.id, stage, payload: { legacy: true } });
  }
  return updated!;
}

async function cachedStages(documentId: string) {
  return getDb()
    .select({ stage: rawExtractions.stage, payload: rawExtractions.payload })
    .from(rawExtractions)
    .where(eq(rawExtractions.documentId, documentId));
}

function reprocess(documentId: string) {
  return POST(
    new Request(`http://localhost/api/documents/${documentId}/reprocess`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

interface ReprocessJson {
  document?: {
    id: string;
    status: string;
    stageError: unknown;
    attempts: number;
  };
  jobId?: string | null;
  enqueued?: boolean;
  error?: string;
  status?: string;
}

async function ingestJobCount(sha256: string): Promise<number> {
  const rows = (await getSqlClient().unsafe(
    "select id from pgboss.job where name = 'ingest' and singleton_key = $1",
    [sha256],
  )) as unknown as { id: string }[];
  return rows.length;
}

describe("POST /api/documents/[id]/reprocess", () => {
  // A pristine pool for the stage executor: drizzle's postgres-js driver
  // mutates the json/jsonb serializers of any pool it wraps (the app pool is
  // wrapped via inTransaction), which breaks the executor's sql.json() binds
  // — see drizzleWithoutHijack in worker/normalize.ts. worker/ingestion.test.ts
  // sidesteps this the same way.
  let workerSql: postgres.Sql;

  beforeAll(async () => {
    workerSql = postgres(TEST_DATABASE_URL, { max: 2 });
    await getBoss();
  }, 60_000);

  beforeEach(async () => {
    await getSqlClient().unsafe("delete from pgboss.job");
  });

  afterAll(async () => {
    await stopBoss();
    await getSqlClient().end({ timeout: 1 });
    await workerSql.end();
  });

  it("resets a done document, clears the stage cache, and re-enqueues", async () => {
    const doc = await insertProcessedDocument("done", 2);

    const res = await reprocess(doc.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ReprocessJson;
    expect(body.document?.id).toBe(doc.id);
    expect(body.document?.status).toBe("uploaded");
    expect(body.document?.stageError).toBeNull();
    // Attempts are preserved, as on the retry path.
    expect(body.document?.attempts).toBe(2);
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    // The stale stage cache is gone, so the resumed job re-runs every stage.
    expect(await cachedStages(doc.id)).toEqual([]);
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("drives a done document back to done through the real stage executor", async () => {
    const doc = await insertProcessedDocument("done");

    const res = await reprocess(doc.id);
    expect(res.status).toBe(200);

    // Simulate the worker picking up the enqueued job (stub stages stand in
    // for the real implementations, as in worker/ingestion.test.ts).
    const outcome = await runIngestion(workerSql, doc.id);

    expect(outcome).toEqual({ kind: "done" });
    const stored = await getDb().query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(stored?.status).toBe("done");
    expect(stored?.stageError).toBeNull();
    // Every stage re-ran: the cache holds fresh stub payloads, no legacy ones.
    const cached = await cachedStages(doc.id);
    expect(cached.map((row) => row.stage).sort()).toEqual(
      [...LEGACY_STAGES].sort(),
    );
    for (const row of cached) {
      expect(row.payload).toEqual({ stub: true });
    }
  });

  it("keeps metadata overrides across a reprocess", async () => {
    const doc = await insertProcessedDocument("done");
    await updateMetadataOverrides(getDb(), doc.id, {
      documentType: "lab_report",
      provider: "UAB Hila",
    });

    const res = await reprocess(doc.id);

    expect(res.status).toBe(200);
    const stored = await getDb().query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(stored?.metadataOverrides).toEqual({
      documentType: "lab_report",
      provider: "UAB Hila",
    });
  });

  it.each(["failed", "needs_review", "uploaded", "ignored"] as const)(
    '409s when the document is "%s", leaving cache and queue untouched',
    async (status) => {
      const doc = await insertProcessedDocument(status);

      const res = await reprocess(doc.id);

      expect(res.status).toBe(409);
      const body = (await res.json()) as ReprocessJson;
      expect(body.error).toContain(`"${status}"`);
      expect(body.error).toContain("done");
      expect((await cachedStages(doc.id)).length).toBe(LEGACY_STAGES.length);
      expect(await ingestJobCount(doc.sha256)).toBe(0);
    },
  );

  it("suppresses the duplicate enqueue when a job is still active", async () => {
    const doc = await insertProcessedDocument("done");

    const first = await reprocess(doc.id);
    expect(((await first.json()) as ReprocessJson).enqueued).toBe(true);

    // Force the document back to done while its job is still active: the
    // singleton key must keep a second job out of the queue.
    await updateStatus(getDb(), doc.id, "done");
    const second = await reprocess(doc.id);

    expect(second.status).toBe(200);
    const body = (await second.json()) as ReprocessJson;
    expect(body.enqueued).toBe(false);
    expect(body.jobId).toBeNull();
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("404s for unknown and malformed ids", async () => {
    const res = await reprocess(randomUUID());
    expect(res.status).toBe(404);

    const malformed = await reprocess("not-a-uuid");
    expect(malformed.status).toBe(404);
  });
});
