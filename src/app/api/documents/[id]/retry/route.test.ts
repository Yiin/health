import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSqlClient } from "@/db";
import { registerUpload, updateStatus } from "@/db/repos/documents";
import { documents, type DocumentStatus } from "@/db/schema";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";
import { getBoss, stopBoss } from "@/lib/queue";

import { POST } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

function freshSha256(): string {
  return randomBytes(32).toString("hex");
}

async function insertDocumentWithStatus(status: DocumentStatus, attempts = 0) {
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
  const updated = await updateStatus(getDb(), document.id, status, {
    stage: "extracting",
    message: "kimi timeout",
  });
  return updated!;
}

function retry(documentId: string) {
  return POST(
    new Request(`http://localhost/api/documents/${documentId}/retry`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

function retryWithBody(documentId: string, body: unknown) {
  return POST(
    new Request(`http://localhost/api/documents/${documentId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

interface RetryJson {
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

describe("POST /api/documents/[id]/retry", () => {
  beforeAll(async () => {
    await getBoss();
  }, 60_000);

  beforeEach(async () => {
    await getSqlClient().unsafe("delete from pgboss.job");
  });

  afterAll(async () => {
    await stopBoss();
    await getSqlClient().end({ timeout: 1 });
  });

  it("resets a failed document and re-enqueues ingestion", async () => {
    const doc = await insertDocumentWithStatus("failed", 2);

    const res = await retry(doc.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RetryJson;
    expect(body.document?.id).toBe(doc.id);
    expect(body.document?.status).toBe("uploaded");
    expect(body.document?.stageError).toBeNull();
    // Attempts are preserved across retries.
    expect(body.document?.attempts).toBe(2);
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("resets a needs_review document too", async () => {
    const doc = await insertDocumentWithStatus("needs_review");

    const res = await retry(doc.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RetryJson;
    expect(body.document?.status).toBe("uploaded");
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("409s when the document is not in a retryable state", async () => {
    const doc = await insertDocumentWithStatus("done");

    const res = await retry(doc.id);

    expect(res.status).toBe(409);
    const body = (await res.json()) as RetryJson;
    expect(body.error).toContain('"done"');
    expect(body.error).toContain("failed or needs_review");
    expect(await ingestJobCount(doc.sha256)).toBe(0);
  });

  it("suppresses the duplicate enqueue when a job is still active", async () => {
    const doc = await insertDocumentWithStatus("failed");

    const first = await retry(doc.id);
    expect(((await first.json()) as RetryJson).enqueued).toBe(true);

    // Force the document back to failed while its job is still active: the
    // singleton key must keep a second job out of the queue.
    await updateStatus(getDb(), doc.id, "failed", {
      stage: "extracting",
      message: "kimi timeout again",
    });
    const second = await retry(doc.id);

    expect(second.status).toBe(200);
    const body = (await second.json()) as RetryJson;
    expect(body.enqueued).toBe(false);
    expect(body.jobId).toBeNull();
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("404s for unknown and malformed ids", async () => {
    const res = await retry(randomUUID());
    expect(res.status).toBe(404);

    const malformed = await retry("not-a-uuid");
    expect(malformed.status).toBe(404);
  });

  it('"Process as…" stores the type hint and re-enqueues in one call', async () => {
    const doc = await insertDocumentWithStatus("needs_review");

    const res = await retryWithBody(doc.id, { documentType: "lab_report" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RetryJson;
    expect(body.document?.status).toBe("uploaded");
    expect(body.enqueued).toBe(true);

    const stored = await getDb().query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(stored?.metadataOverrides?.documentType).toBe("lab_report");
    expect(await ingestJobCount(doc.sha256)).toBe(1);
  });

  it("treats a JSON body without documentType as a plain retry", async () => {
    const doc = await insertDocumentWithStatus("failed");

    const res = await retryWithBody(doc.id, {});

    expect(res.status).toBe(200);
    const stored = await getDb().query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(stored?.metadataOverrides).toBeNull();
  });

  it("400s on a malformed body or an unknown documentType", async () => {
    const doc = await insertDocumentWithStatus("needs_review");

    const notJson = await retryWithBody(doc.id, "{oops");
    expect(notJson.status).toBe(400);

    const badType = await retryWithBody(doc.id, { documentType: "novel" });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as RetryJson).error).toContain(
      "documentType",
    );

    // A rejected hint must not disturb the document or the queue.
    const stored = await getDb().query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(stored?.status).toBe("needs_review");
    expect(await ingestJobCount(doc.sha256)).toBe(0);
  });
});
