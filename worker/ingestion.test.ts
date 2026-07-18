import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";
import { KimiError } from "../src/lib/kimi/client";

import {
  INGESTION_STAGES,
  MAX_ATTEMPTS,
  MAX_JOB_EXECUTIONS,
  OUTAGE_RETRY_LIMIT,
  runIngestion,
  StagePendingError,
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

async function insertChildDocument(
  parentId: string,
  status = "uploaded",
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents
      (sha256, original_filename, s3_key, status, parent_document_id)
    values (
      ${crypto.randomUUID()}, 'inner.csv', 'originals//cd/inner', ${status},
      ${parentId}
    )
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
    expect(calls).toEqual(["extracting", "normalizing", "summarizing"]);
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
    for (const attempt of [1, 2]) {
      await expect(
        runIngestion(sql, id, { stages: alwaysThrows, attempt }),
      ).rejects.toThrow("boom");
    }
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
    expect(calls).toEqual(["extracting", "normalizing", "summarizing"]);
    expect((await documentRow(id)).status).toBe("done");
  });

  it("halts the pipeline when a stage payload carries a halt marker", async () => {
    const id = await insertDocument();
    const calls: IngestionStage[] = [];
    const stages = countingStages(calls, {
      classifying: async () => ({
        promptVersion: "classify-v1",
        docType: "unknown",
        halt: { status: "ignored", reason: "unrecognized content" },
      }),
    });

    const outcome = await runIngestion(sql, id, { stages });

    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "ignored",
    });
    // Later stages never ran; the halt payload is cached like any other.
    expect(calls).toEqual(["classifying"]);
    const doc = await documentRow(id);
    expect(doc.status).toBe("ignored");
    expect(doc.stage_error).toBeNull();
    const rows = await extractionRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("classifying");
    expect(rows[0].payload).toMatchObject({ halt: { status: "ignored" } });

    // A halted (terminal) document is skipped by later jobs.
    expect(await runIngestion(sql, id)).toEqual({
      kind: "skipped",
      status: "ignored",
    });
  });

  it("resumes past a cached halt when a needs_review document is retried", async () => {
    const id = await insertDocument();
    const halting = countingStages([], {
      classifying: async () => ({
        docType: "lab_report",
        halt: { status: "needs_review", reason: "low confidence" },
      }),
    });
    const outcome = await runIngestion(sql, id, { stages: halting });
    expect(outcome).toEqual({
      kind: "halted",
      stage: "classifying",
      status: "needs_review",
    });
    expect((await documentRow(id)).status).toBe("needs_review");

    // Mirror resetDocumentForRetry (src/lib/uploads.ts): back to uploaded,
    // stage_error cleared, attempts preserved.
    await sql`
      update documents set status = 'uploaded', stage_error = null
      where id = ${id}
    `;

    const calls: IngestionStage[] = [];
    const resumed = await runIngestion(sql, id, {
      stages: countingStages(calls),
    });
    expect(resumed).toEqual({ kind: "done" });
    // classifying was cached from the halted run and is not re-executed.
    expect(calls).toEqual(["extracting", "normalizing", "summarizing"]);
    expect((await documentRow(id)).status).toBe("done");
  });

  it("returns missing for an unknown document", async () => {
    expect(await runIngestion(sql, crypto.randomUUID())).toEqual({
      kind: "missing",
    });
  });

  it("parks a document when a stage throws StagePendingError", async () => {
    const id = await insertDocument();
    const calls: IngestionStage[] = [];
    const parking = countingStages(calls, {
      normalizing: async () => {
        throw new StagePendingError("2 of 3 child documents still ingesting");
      },
    });

    const outcome = await runIngestion(sql, id, { stages: parking });

    expect(outcome).toEqual({
      kind: "pending",
      stage: "normalizing",
      message: "2 of 3 child documents still ingesting",
    });
    const doc = await documentRow(id);
    // Parked: non-terminal status, no stage_error, no cached payload for the
    // parking stage, and the job RESOLVED (no pg-boss retry is needed).
    expect(doc.status).toBe("normalizing");
    expect(doc.stage_error).toBeNull();
    expect((await extractionRows(id)).map((r) => r.stage)).toEqual([
      "classifying",
      "extracting",
    ]);

    // A re-driven run re-executes the parking stage (nothing was cached).
    calls.length = 0;
    const second = await runIngestion(sql, id, {
      stages: countingStages(calls),
    });
    expect(second).toEqual({ kind: "done" });
    expect(calls).toEqual(["normalizing", "summarizing"]);
  });

  it("completes a barrier-parked parent when its last child turns terminal", async () => {
    const parentId = await insertDocument("normalizing");
    // Fan-out already happened (the barrier only runs after it is cached).
    await sql`
      insert into raw_extractions (document_id, stage, payload)
      values (${parentId}, 'extracting', ${sql.json({ archive: { files: 2 } })})
    `;
    const doneChild = await insertChildDocument(parentId, "done");
    const runningChild = await insertChildDocument(parentId, "uploaded");

    // First child turning terminal: a sibling is still pending → parked.
    expect(
      await runIngestion(sql, runningChild, { stages: stubStages }),
    ).toEqual({ kind: "done" });
    expect((await documentRow(parentId)).status).toBe("done");

    const rows = await sql<{ stage: string; payload: unknown }[]>`
      select stage, payload from raw_extractions
      where document_id = ${parentId} order by stage
    `;
    expect(rows.map((r) => r.stage)).toEqual(["extracting", "normalizing"]);
    expect(rows[1].payload).toMatchObject({
      barrier: "children_terminal",
      childDocumentId: runningChild,
    });
    expect(doneChild).toBeTruthy(); // fixture sanity
  });

  it("leaves the parent parked while any child is non-terminal", async () => {
    const parentId = await insertDocument("normalizing");
    const pendingChild = await insertChildDocument(parentId, "uploaded");
    const finishingChild = await insertChildDocument(parentId, "uploaded");

    await runIngestion(sql, finishingChild, { stages: stubStages });
    expect((await documentRow(parentId)).status).toBe("normalizing");

    // The sibling finishing — even into a FAILED terminal state — completes
    // the parent: a failed child does not fail the parent.
    const failing = {
      ...stubStages,
      classifying: async () => {
        throw new Error("unreadable");
      },
    };
    for (const attempt of [1, 2]) {
      await expect(
        runIngestion(sql, pendingChild, { stages: failing, attempt }),
      ).rejects.toThrow("unreadable");
    }
    expect(
      await runIngestion(sql, pendingChild, {
        stages: failing,
        attempt: MAX_ATTEMPTS,
      }),
    ).toMatchObject({ kind: "failed" });
    expect((await documentRow(parentId)).status).toBe("done");
  });

  it("does not complete a parent that is not parked at the barrier", async () => {
    // A parent mid-run in its own job (status 'extracting') must be left to
    // its own barrier stage, not completed by a child.
    const parentId = await insertDocument("extracting");
    const childId = await insertChildDocument(parentId, "uploaded");

    expect(await runIngestion(sql, childId, { stages: stubStages })).toEqual({
      kind: "done",
    });
    expect((await documentRow(parentId)).status).toBe("extracting");
  });

  it("halts the run when a stage payload carries a halt marker", async () => {
    const id = await insertDocument();
    const calls: IngestionStage[] = [];
    const stages = countingStages(calls, {
      extracting: async () => ({
        textChars: 12,
        halt: { status: "needs_review", reason: "scanned" },
      }),
    });

    const outcome = await runIngestion(sql, id, { stages });
    expect(outcome).toEqual({
      kind: "halted",
      stage: "extracting",
      status: "needs_review",
    });
    // Later stages never run; the halt payload is cached like any other.
    expect(calls).toEqual(["classifying", "extracting"]);
    expect((await extractionRows(id)).map((r) => r.stage)).toEqual([
      "classifying",
      "extracting",
    ]);
    const doc = await documentRow(id);
    expect(doc.status).toBe("needs_review");
    expect(doc.stage_error).toBeNull();
    // A halted document is terminal — later jobs are no-ops.
    expect(await runIngestion(sql, id, { stages })).toEqual({
      kind: "skipped",
      status: "needs_review",
    });
  });

  it("records stage_error when the halt carries an error message", async () => {
    const id = await insertDocument();
    const stages = countingStages([], {
      extracting: async () => ({
        halt: {
          status: "needs_review",
          reason: "extraction validation failed",
          error:
            "extraction failed validation on kimi-k2.6, its retry, and kimi-k3",
        },
      }),
    });

    const outcome = await runIngestion(sql, id, { stages, attempt: 1 });
    expect(outcome).toEqual({
      kind: "halted",
      stage: "extracting",
      status: "needs_review",
    });
    const doc = await documentRow(id);
    expect(doc.status).toBe("needs_review");
    expect(doc.stage_error).toMatchObject({
      stage: "extracting",
      message:
        "extraction failed validation on kimi-k2.6, its retry, and kimi-k3",
    });
    expect(doc.stage_error?.at).toBeTruthy();
  });

  it("ignores malformed halt markers and proceeds", async () => {
    const id = await insertDocument();
    const stages = countingStages([], {
      extracting: async () => ({ halt: { status: "done" } }),
    });
    const outcome = await runIngestion(sql, id, { stages });
    expect(outcome).toEqual({ kind: "done" });
    expect((await documentRow(id)).status).toBe("done");
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

describe("runIngestion — Kimi outage semantics", () => {
  const outage = () => new KimiError("server", "Kimi server error (503): down");

  it("retries outages with their own counter, then fails with an actionable stage_error", async () => {
    const id = await insertDocument();
    const outageStages = countingStages([], {
      extracting: async () => {
        throw outage();
      },
    });

    // Every pre-final execution rethrows (pg-boss schedules the backoff
    // retry) and increments ONLY the outage counter.
    for (let attempt = 1; attempt < OUTAGE_RETRY_LIMIT; attempt += 1) {
      await expect(
        runIngestion(sql, id, { stages: outageStages, attempt }),
      ).rejects.toThrow("down");
      const doc = await documentRow(id);
      expect(doc.status).toBe("extracting");
      expect(doc.stage_error).toMatchObject({
        stage: "extracting",
        kind: "outage",
        outageRetries: attempt,
        errorAttempts: 0,
      });
    }

    const outcome = await runIngestion(sql, id, {
      stages: outageStages,
      attempt: OUTAGE_RETRY_LIMIT,
    });
    expect(outcome).toMatchObject({ kind: "failed", stage: "extracting" });
    const doc = await documentRow(id);
    expect(doc.status).toBe("failed");
    expect(doc.attempts).toBe(OUTAGE_RETRY_LIMIT);
    expect(doc.stage_error).toMatchObject({
      kind: "outage",
      outageRetries: OUTAGE_RETRY_LIMIT,
      errorAttempts: 0,
    });
    // The recorded message tells the operator what to check and how to
    // recover — that is the acceptance bar for "actionable".
    expect(doc.stage_error?.message).toMatch(/Kimi API unavailable/);
    expect(doc.stage_error?.message).toMatch(/MOONSHOT_API_KEY/);
    expect(doc.stage_error?.message).toMatch(/Retry/);
  });

  it("does not burn real attempts on outage executions", async () => {
    const id = await insertDocument();
    const errors: Error[] = [
      outage(),
      new Error("boom 1"),
      new Error("boom 2"),
      new Error("boom 3"),
    ];
    const stages = countingStages([], {
      extracting: async () => {
        throw errors.shift() ?? new Error("exhausted");
      },
    });

    // Outage first, then three real failures: the document still gets its
    // full MAX_ATTEMPTS real attempts — the outage consumed none of them.
    for (const attempt of [1, 2, 3]) {
      await expect(
        runIngestion(sql, id, { stages, attempt }),
      ).rejects.toThrow();
    }
    expect((await documentRow(id)).stage_error).toMatchObject({
      kind: "error",
      errorAttempts: 2,
      outageRetries: 1,
    });

    const outcome = await runIngestion(sql, id, { stages, attempt: 4 });
    expect(outcome).toMatchObject({ kind: "failed", message: "boom 3" });
    const doc = await documentRow(id);
    expect(doc.attempts).toBe(4);
    expect(doc.stage_error).toMatchObject({
      kind: "error",
      errorAttempts: MAX_ATTEMPTS,
      outageRetries: 1,
    });
  });

  it("completes normally once connectivity is restored mid-retry", async () => {
    const id = await insertDocument();
    let failuresLeft = 2;
    const flaky = countingStages([], {
      extracting: async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw outage();
        }
        return { recovered: true };
      },
    });

    for (const attempt of [1, 2]) {
      await expect(
        runIngestion(sql, id, { stages: flaky, attempt }),
      ).rejects.toThrow("down");
    }
    const outcome = await runIngestion(sql, id, { stages: flaky, attempt: 3 });
    expect(outcome).toEqual({ kind: "done" });
    const doc = await documentRow(id);
    expect(doc.status).toBe("done");
    expect(doc.stage_error).toBeNull();
  });

  it("resets both counters when the pipeline reaches a new stage", async () => {
    const id = await insertDocument();
    let classifyFailures = 1;
    const stages = countingStages([], {
      classifying: async () => {
        if (classifyFailures > 0) {
          classifyFailures -= 1;
          throw new Error("classify hiccup");
        }
        return { ok: true };
      },
      extracting: async () => {
        throw outage();
      },
    });

    await expect(
      runIngestion(sql, id, { stages, attempt: 1 }),
    ).rejects.toThrow("classify hiccup");
    await expect(runIngestion(sql, id, { stages, attempt: 2 })).rejects.toThrow(
      "down",
    );
    // The extracting failure starts from a clean slate: the classifying
    // counters do not leak into the new stage.
    expect((await documentRow(id)).stage_error).toMatchObject({
      stage: "extracting",
      kind: "outage",
      outageRetries: 1,
      errorAttempts: 0,
    });
  });

  it("force-fails when pg-boss is out of executions regardless of counters", async () => {
    const id = await insertDocument();
    const stages = countingStages([], {
      extracting: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await runIngestion(sql, id, {
      stages,
      attempt: MAX_JOB_EXECUTIONS,
    });
    expect(outcome).toMatchObject({ kind: "failed", stage: "extracting" });
    expect((await documentRow(id)).status).toBe("failed");
  });
});
