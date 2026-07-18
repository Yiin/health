import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";

import {
  INGESTION_STAGES,
  MAX_ATTEMPTS,
  runIngestion,
  stubStages,
  type IngestionStage,
} from "./ingestion";

setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

async function insertDocument(status = "uploaded"): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents (sha256, original_filename, s3_key, status)
    values (${crypto.randomUUID()}, 'fixture.pdf', 'originals//ab/fixture', ${status})
    returning id
  `;
  return rows[0].id;
}

async function documentRow(id: string) {
  const rows = await sql<
    {
      status: string;
      attempts: number;
      stage_error: { stage: string; message: string; at: string } | null;
    }[]
  >`
    select status, attempts, stage_error from documents where id = ${id}
  `;
  return rows[0];
}

async function extractionRows(id: string) {
  return sql<{ stage: string; payload: unknown }[]>`
    select stage, payload from raw_extractions
    where document_id = ${id}
    order by created_at, stage
  `;
}

function countingStages(
  calls: IngestionStage[],
  overrides: Partial<
    Record<IngestionStage, () => Promise<postgres.JSONValue>>
  > = {},
) {
  const stages = { ...stubStages };
  for (const stage of INGESTION_STAGES) {
    const inner = overrides[stage];
    stages[stage] = async () => {
      calls.push(stage);
      return inner ? inner() : { stub: true, stage };
    };
  }
  return stages;
}

describe("runIngestion", () => {
  it("walks a fixture document through all stages to done", async () => {
    const id = await insertDocument();
    const calls: IngestionStage[] = [];

    const outcome = await runIngestion(sql, id, {
      stages: countingStages(calls),
    });

    expect(outcome).toEqual({ kind: "done" });
    expect(calls).toEqual([...INGESTION_STAGES]);
    expect(await documentRow(id)).toEqual({
      status: "done",
      attempts: 1,
      stage_error: null,
    });
    const rows = await extractionRows(id);
    expect(rows.map((r) => r.stage)).toEqual([...INGESTION_STAGES]);
    expect(rows[0].payload).toEqual({ stub: true, stage: "classifying" });
  });

  it("resumes from cached stages after a mid-pipeline crash", async () => {
    const id = await insertDocument();
    const calls: IngestionStage[] = [];

    // First pass dies inside `extracting` (non-final attempt → rethrow).
    await expect(
      runIngestion(sql, id, {
        stages: countingStages(calls, {
          extracting: async () => {
            throw new Error("crash");
          },
        }),
      }),
    ).rejects.toThrow("crash");
    expect(calls).toEqual(["classifying", "extracting"]);

    const midRun = await documentRow(id);
    expect(midRun.status).toBe("extracting");
    expect(midRun.stage_error).toMatchObject({
      stage: "extracting",
      message: "crash",
    });
    expect(midRun.stage_error?.at).toBeTruthy();
    expect((await extractionRows(id)).map((r) => r.stage)).toEqual([
      "classifying",
    ]);

    // Second pass: classifying is served from the cache, never re-run.
    calls.length = 0;
    const outcome = await runIngestion(sql, id, {
      stages: countingStages(calls),
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(calls).toEqual(["extracting", "normalizing"]);
    expect(await documentRow(id)).toEqual({
      status: "done",
      attempts: 2,
      stage_error: null,
    });
    expect(await extractionRows(id)).toHaveLength(INGESTION_STAGES.length);
  });

  it("lands a hard failure in failed on the final attempt with stage_error", async () => {
    const id = await insertDocument();
    const alwaysThrows = countingStages([], {
      extracting: async () => {
        throw new Error("boom");
      },
    });

    // Attempts 1 and 2 rethrow so pg-boss schedules the retry.
    for (const attempt of [1, 2]) {
      await expect(
        runIngestion(sql, id, { stages: alwaysThrows, attempt }),
      ).rejects.toThrow("boom");
      expect((await documentRow(id)).status).toBe("extracting");
    }

    // Final attempt: the document fails and the job resolves instead of
    // throwing, so pg-boss burns no extra retry.
    const outcome = await runIngestion(sql, id, {
      stages: alwaysThrows,
      attempt: MAX_ATTEMPTS,
    });
    expect(outcome).toEqual({
      kind: "failed",
      stage: "extracting",
      message: "boom",
    });
    const doc = await documentRow(id);
    expect(doc.status).toBe("failed");
    expect(doc.attempts).toBe(MAX_ATTEMPTS);
    expect(doc.stage_error).toMatchObject({
      stage: "extracting",
      message: "boom",
    });
    expect(doc.stage_error?.at).toBeTruthy();
    expect((await extractionRows(id)).map((r) => r.stage)).toEqual([
      "classifying",
    ]);

    // A later job for the failed document is a no-op until the retry
    // endpoint resets it.
    expect(await runIngestion(sql, id)).toEqual({
      kind: "skipped",
      status: "failed",
    });
  });

  it("resumes from the cache after the retry endpoint resets a failure", async () => {
    const id = await insertDocument();
    const alwaysThrows = countingStages([], {
      extracting: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      runIngestion(sql, id, { stages: alwaysThrows, attempt: MAX_ATTEMPTS }),
    ).resolves.toMatchObject({ kind: "failed" });

    // Mirror resetDocumentForRetry (src/lib/uploads.ts): back to uploaded,
    // stage_error cleared, attempts preserved.
    await sql`
      update documents set status = 'uploaded', stage_error = null
      where id = ${id}
    `;

    const calls: IngestionStage[] = [];
    const outcome = await runIngestion(sql, id, {
      stages: countingStages(calls),
    });
    expect(outcome).toEqual({ kind: "done" });
    // classifying was cached from the failed run and is not re-executed.
    expect(calls).toEqual(["extracting", "normalizing"]);
    expect((await documentRow(id)).status).toBe("done");
  });

  it("returns missing for an unknown document", async () => {
    expect(await runIngestion(sql, crypto.randomUUID())).toEqual({
      kind: "missing",
    });
  });

  it("skips terminal documents without touching attempts", async () => {
    const id = await insertDocument("needs_review");
    expect(await runIngestion(sql, id)).toEqual({
      kind: "skipped",
      status: "needs_review",
    });
    expect((await documentRow(id)).attempts).toBe(0);
  });
});
