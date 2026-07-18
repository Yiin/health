// End-to-end worker tests: real pg-boss against the test database, driving
// jobs through the actual work() subscription in worker/index.mjs.

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";

import { stubStages } from "./ingestion";
import { startWorker } from "./index.mjs";

setupTestDb();

let sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 4 });
});
afterEach(async () => {
  // test-utils truncates only the public schema; pg-boss job rows would
  // otherwise leak into other test files that count them (queue.test.ts).
  await sql`delete from pgboss.job`;
});
afterAll(async () => {
  await sql.end();
});

// Keep test output readable; pg-boss background errors surface via assertions.
const silentLog = { log: () => {}, error: () => {} };

async function insertDocument(status = "uploaded") {
  const rows = await sql`
    insert into documents (sha256, original_filename, s3_key, status)
    values (${crypto.randomUUID()}, 'fixture.pdf', 'originals//ab/fixture', ${status})
    returning id
  `;
  return rows[0].id;
}

async function documentRow(id) {
  const rows = await sql`
    select status, attempts, stage_error from documents where id = ${id}
  `;
  return rows[0];
}

async function waitFor(condition, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sendOptions = { retryLimit: 3, retryDelay: 0 };

describe("worker (pg-boss loop)", () => {
  it(
    "walks an enqueued document through all stages to done",
    async () => {
      const worker = await startWorker({
        databaseUrl: TEST_DATABASE_URL,
        pollingIntervalSeconds: 0.5,
        log: silentLog,
      });
      try {
        const id = await insertDocument();
        const jobId = await worker.boss.send(
          "ingest",
          { documentId: id },
          { ...sendOptions, singletonKey: `sha-${id}` },
        );
        expect(jobId).toBeTruthy();

        await waitFor(
          async () => (await documentRow(id)).status === "done",
          "document to reach done",
        );

        const doc = await documentRow(id);
        expect(doc).toEqual({ status: "done", attempts: 1, stage_error: null });
        const rows = await sql`
          select stage from raw_extractions
          where document_id = ${id}
          order by created_at, stage
        `;
        expect(rows.map((r) => r.stage)).toEqual([
          "classifying",
          "extracting",
          "normalizing",
        ]);
        const job = await worker.boss.getJobById("ingest", jobId);
        expect(job?.state).toBe("completed");
      } finally {
        await worker.stop();
      }
    },
    30_000,
  );

  it(
    "lands a document in failed after exactly 3 attempts when a stage always throws",
    async () => {
      const failingStages = {
        ...stubStages,
        extracting: async () => {
          throw new Error("boom");
        },
      };
      const worker = await startWorker({
        databaseUrl: TEST_DATABASE_URL,
        stages: failingStages,
        pollingIntervalSeconds: 0.5,
        log: silentLog,
      });
      try {
        const id = await insertDocument();
        const jobId = await worker.boss.send(
          "ingest",
          { documentId: id },
          { ...sendOptions, singletonKey: `sha-${id}` },
        );

        await waitFor(
          async () => (await documentRow(id)).status === "failed",
          "document to reach failed",
        );

        const doc = await documentRow(id);
        expect(doc.attempts).toBe(3);
        expect(doc.stage_error).toMatchObject({
          stage: "extracting",
          message: "boom",
        });
        expect(doc.stage_error.at).toBeTruthy();
        const rows = await sql`
          select stage from raw_extractions where document_id = ${id}
        `;
        expect(rows.map((r) => r.stage)).toEqual(["classifying"]);
        // The executor resolves the final attempt itself, so the job is
        // complete (not failed) and pg-boss schedules no fourth execution.
        const job = await worker.boss.getJobById("ingest", jobId);
        expect(job?.state).toBe("completed");
      } finally {
        await worker.stop();
      }
    },
    30_000,
  );

  it(
    "stop() mid-stage requeues the job; a restarted worker resumes without duplicate rows",
    async () => {
      // extracting blocks until the worker aborts the job's signal (grace
      // period expired) — the closest in-process stand-in for SIGKILL/SIGTERM
      // landing mid-stage.
      const blockedStages = {
        ...stubStages,
        extracting: ({ signal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ stub: true }), 10_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted mid-stage"));
            });
          }),
      };
      const first = await startWorker({
        databaseUrl: TEST_DATABASE_URL,
        stages: blockedStages,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 1_000,
        log: silentLog,
      });

      const id = await insertDocument();
      await first.boss.send(
        "ingest",
        { documentId: id },
        { ...sendOptions, singletonKey: `sha-${id}` },
      );
      await waitFor(
        async () => (await documentRow(id)).status === "extracting",
        "first worker to be mid-extracting",
      );

      // Grace period expires while extracting is still blocked: pg-boss
      // fails the active job back to retry and aborts its signal.
      await first.stop();
      expect((await documentRow(id)).status).not.toBe("done");

      const second = await startWorker({
        databaseUrl: TEST_DATABASE_URL,
        pollingIntervalSeconds: 0.5,
        log: silentLog,
      });
      try {
        await waitFor(
          async () => (await documentRow(id)).status === "done",
          "restarted worker to resume to done",
        );
        const rows = await sql`
          select stage from raw_extractions
          where document_id = ${id}
          order by created_at, stage
        `;
        expect(rows.map((r) => r.stage)).toEqual([
          "classifying",
          "extracting",
          "normalizing",
        ]);
      } finally {
        await second.stop();
      }
    },
    30_000,
  );
});
