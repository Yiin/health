// GET /api/ingestion/health's data source (src/lib/ingestion-health.ts):
// document status counts from the shared test database, queue depth from a
// real pg-boss instance on the same database, and the fresh-database
// fallback (no pgboss schema yet) against a scratch database.

import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../db/test-utils";

import { getIngestionHealth } from "./ingestion-health";

setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

async function insertDocument(status: string): Promise<void> {
  await sql`
    insert into documents (sha256, original_filename, s3_key, status)
    values (${crypto.randomUUID()}, 'f.pdf', 'originals//ab/f', ${status})
  `;
}

describe("getIngestionHealth", () => {
  it("counts documents by pipeline state", async () => {
    for (const status of [
      "uploaded",
      "classifying",
      "failed",
      "failed",
      "needs_review",
      "done",
      "ignored",
    ]) {
      await insertDocument(status);
    }

    const health = await getIngestionHealth(sql);
    expect(health.documents).toEqual({
      processing: 2,
      failed: 2,
      needsReview: 1,
    });
    expect(health.queue.queued).toBeGreaterThanOrEqual(0);
    expect(health.queue.active).toBeGreaterThanOrEqual(0);
  });

  describe("queue depth from pg-boss", () => {
    let boss: PgBoss;

    beforeAll(async () => {
      boss = new PgBoss({ connectionString: TEST_DATABASE_URL });
      await boss.start();
      await boss.createQueue("ingest", { policy: "exclusive" });
    });
    afterEach(async () => {
      await sql`delete from pgboss.job where name = 'ingest'`;
    });
    afterAll(async () => {
      await boss.stop({ graceful: false });
    });

    it("counts pending ingest jobs as queue depth", async () => {
      // startAfter far in the future keeps both jobs in 'created'.
      await boss.send(
        "ingest",
        { documentId: "a" },
        {
          singletonKey: "sha-a",
          startAfter: 3600,
        },
      );
      await boss.send(
        "ingest",
        { documentId: "b" },
        {
          singletonKey: "sha-b",
          startAfter: 3600,
        },
      );

      const health = await getIngestionHealth(sql);
      expect(health.queue).toEqual({ queued: 2, active: 0 });
    });

    it("ignores jobs of other queues", async () => {
      await boss.createQueue("other-queue");
      await boss.send("other-queue", { x: 1 }, { startAfter: 3600 });

      const health = await getIngestionHealth(sql);
      expect(health.queue).toEqual({ queued: 0, active: 0 });
      await sql`delete from pgboss.job where name = 'other-queue'`;
    });
  });

  it("reads zero queue depth on a fresh database without a pgboss schema", async () => {
    const SCRATCH_DB = "health_test_w3_ingestion_health";
    const adminUrl = new URL(TEST_DATABASE_URL);
    adminUrl.pathname = "/postgres";
    const scratchUrl = new URL(TEST_DATABASE_URL);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    const admin = postgres(adminUrl.toString(), { max: 1 });
    await admin.unsafe(`drop database if exists "${SCRATCH_DB}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH_DB}"`);

    const scratch = postgres(scratchUrl.toString(), { max: 1 });
    try {
      const migrationsFolder = fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      );
      await migrate(drizzle(scratch), { migrationsFolder });

      const health = await getIngestionHealth(scratch);
      expect(health).toEqual({
        queue: { queued: 0, active: 0 },
        documents: { processing: 0, failed: 0, needsReview: 0 },
      });
    } finally {
      await scratch.end();
      await admin
        .unsafe(`drop database if exists "${SCRATCH_DB}" with (force)`)
        .catch(() => {});
      await admin.end();
    }
  });
});
