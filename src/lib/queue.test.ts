import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getSqlClient } from "@/db";
import { registerUpload } from "@/db/repos/documents";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";
import {
  enqueueIngest,
  getBoss,
  INGEST_JOB,
  retryDelaySeconds,
  stopBoss,
} from "@/lib/queue";
import { inTransaction } from "@/lib/uploads";
import { MAX_JOB_EXECUTIONS } from "../../worker/ingestion";

// The service path (boss + app pool) reads DATABASE_URL; point it at the
// test database before anything lazily initializes.
process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

function freshSha256(): string {
  return randomBytes(32).toString("hex");
}

interface JobRow {
  id: string;
  name: string;
  state: string;
  data: { documentId?: string };
  singleton_key: string | null;
  retry_limit: number;
  retry_backoff: boolean;
}

async function jobs(): Promise<JobRow[]> {
  return (await getSqlClient().unsafe(
    `select id, name, state, data, singleton_key, retry_limit, retry_backoff
     from pgboss.job order by created_on`,
  )) as unknown as JobRow[];
}

async function clearJobs(): Promise<void> {
  await getSqlClient().unsafe("delete from pgboss.job");
}

describe("retryDelaySeconds", () => {
  const original = process.env.INGEST_RETRY_DELAY_S;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INGEST_RETRY_DELAY_S;
    } else {
      process.env.INGEST_RETRY_DELAY_S = original;
    }
  });

  // Non-negative integers pass through (0 = immediate retries); everything
  // else falls back to the 30s production default — boss.send asserts
  // Number.isInteger(retryDelay), so a fractional value must never reach it.
  it.each<[string, number]>([
    ["0", 0],
    ["1", 1],
    ["0.5", 30],
    ["-1", 30],
  ])("parses %j as %d", (value, expected) => {
    process.env.INGEST_RETRY_DELAY_S = value;
    expect(retryDelaySeconds()).toBe(expected);
  });

  it("defaults to 30 when unset", () => {
    delete process.env.INGEST_RETRY_DELAY_S;
    expect(retryDelaySeconds()).toBe(30);
  });
});

describe("queue (pg-boss)", () => {
  beforeAll(async () => {
    await getBoss();
  }, 60_000);

  afterEach(clearJobs);

  afterAll(async () => {
    await stopBoss();
    await getSqlClient().end({ timeout: 1 });
  });

  it("enqueues an ingest job with the document id, singleton key, and retry policy", async () => {
    const sha256 = freshSha256();
    const { document } = await registerUpload(getDb(), {
      sha256,
      filename: "labs.pdf",
      s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
    });

    const jobId = await enqueueIngest(document);

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: INGEST_JOB,
      state: "created",
      singleton_key: sha256,
      // Sized so 3 real attempts + 5 outage retries fit in one job — see
      // worker/ingestion.ts MAX_JOB_EXECUTIONS.
      retry_limit: MAX_JOB_EXECUTIONS - 1,
      retry_backoff: true,
    });
    expect(rows[0]?.data.documentId).toBe(document.id);
  });

  it("suppresses a second job for the same sha256 while one is active", async () => {
    const sha256 = freshSha256();
    const { document } = await registerUpload(getDb(), {
      sha256,
      filename: "labs.pdf",
      s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
    });

    const first = await enqueueIngest(document);
    const second = await enqueueIngest(document);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await jobs()).toHaveLength(1);
  });

  it("commits the document insert and the enqueue in one transaction", async () => {
    const sha256 = freshSha256();
    const result = await inTransaction(async (txDb, bossTx) => {
      const registered = await registerUpload(txDb, {
        sha256,
        filename: "labs.pdf",
        s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
      });
      const jobId = await enqueueIngest(registered.document, { db: bossTx });
      return { document: registered.document, jobId };
    });

    expect(result.jobId).not.toBeNull();
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.documentId).toBe(result.document.id);
  });

  it("rolls back the job when the transaction around it fails", async () => {
    const sha256 = freshSha256();
    const attempt = inTransaction(async (txDb, bossTx) => {
      const { document } = await registerUpload(txDb, {
        sha256,
        filename: "labs.pdf",
        s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
      });
      await enqueueIngest(document, { db: bossTx });
      throw new Error("simulated failure after enqueue");
    });

    await expect(attempt).rejects.toThrow("simulated failure after enqueue");

    // A document must never exist without its job — nor a job without its
    // document: both vanished with the rollback.
    expect(await jobs()).toHaveLength(0);
    const leftover = await getSqlClient().unsafe(
      "select id from documents where sha256 = $1",
      [sha256],
    );
    expect(leftover).toHaveLength(0);
  });
});
