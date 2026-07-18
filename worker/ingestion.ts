// Ingestion stage executor: walks one document through the pipeline
// classifying → extracting → normalizing → done, RESUMING from persisted
// state. Each finished stage caches its output in raw_extractions (unique per
// document+stage), so a retried or restarted job reuses prior stage output
// instead of re-running it, and documents.status tracks the stage currently
// being attempted, which is what makes a mid-stage crash safe to resume.
//
// Stage implementations are STUBS in this issue — each records a placeholder
// payload; real classification/extraction/normalization land in later issues
// and replace entries in `stubStages`.
//
// This module runs in the worker container under plain node type stripping
// (worker/index.mjs imports it directly), so its import graph must stay free
// of relative imports: node ESM will not resolve the extensionless specifiers
// the app code uses. Hence raw postgres.js SQL here (same pattern as
// scripts/seed-biomarkers.mjs) instead of the drizzle repos in src/db.

import type postgres from "postgres";

export const INGESTION_STAGES = [
  "classifying",
  "extracting",
  "normalizing",
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

/**
 * Attempts per ingest job; must match the retryLimit on the queue
 * (src/lib/queue.ts enqueueIngest). pg-boss executes a job at most
 * retryLimit+1 times, so with MAX_ATTEMPTS = retryLimit the executor sees the
 * final attempt first and resolves the job itself instead of letting pg-boss
 * burn one more retry on a document that is already marked failed.
 */
export const MAX_ATTEMPTS = 3;

export interface StageContext {
  documentId: string;
  sha256: string;
  originalFilename: string;
  /** 1-based attempt number of the current job execution. */
  attempt: number;
  /** Aborted when the worker shuts down past its grace period. */
  signal?: AbortSignal;
}

/** A stage returns the payload cached in raw_extractions for later resumes. */
export type StageRunner = (ctx: StageContext) => Promise<postgres.JSONValue>;

/**
 * Placeholder stages. The payload proves the stage ran and is what a resumed
 * job short-circuits on; real implementations replace these one by one.
 */
export const stubStages: Record<IngestionStage, StageRunner> = {
  classifying: async () => ({ stub: true }),
  extracting: async () => ({ stub: true }),
  normalizing: async () => ({ stub: true }),
};

interface DocumentRow {
  id: string;
  status: string;
  sha256: string;
  original_filename: string;
}

export type IngestionOutcome =
  | { kind: "done" }
  | { kind: "failed"; stage: IngestionStage; message: string }
  | { kind: "skipped"; status: string }
  | { kind: "missing" };

// Statuses a job must not advance: finished runs, and failed/needs_review
// documents waiting on the retry endpoint (which resets them to `uploaded`
// before re-enqueueing).
const TERMINAL_STATUSES = new Set(["done", "failed", "needs_review", "ignored"]);

export interface RunIngestionOptions {
  stages?: Record<IngestionStage, StageRunner>;
  /** 1-based attempt number (pg-boss job.retryCount + 1). */
  attempt?: number;
  signal?: AbortSignal;
  /** Clock override for tests (stage_error.at). */
  now?: () => Date;
}

/**
 * Executes the pipeline for one document. A stage error on a NON-final
 * attempt records stage_error and rethrows so pg-boss schedules the retry; on
 * the final attempt the document lands in `failed` with a populated
 * stage_error and the job resolves (outcome "failed"), so a hard failure
 * costs exactly MAX_ATTEMPTS executions.
 */
export async function runIngestion(
  sql: postgres.Sql,
  documentId: string,
  options: RunIngestionOptions = {},
): Promise<IngestionOutcome> {
  const stages = options.stages ?? stubStages;
  const attempt = options.attempt ?? 1;
  const now = options.now ?? (() => new Date());

  const rows = await sql<DocumentRow[]>`
    select id, status, sha256, original_filename
    from documents
    where id = ${documentId}
  `;
  const document = rows[0];
  if (!document) return { kind: "missing" };
  if (TERMINAL_STATUSES.has(document.status)) {
    return { kind: "skipped", status: document.status };
  }

  await sql`
    update documents set attempts = attempts + 1 where id = ${documentId}
  `;

  const ctx: StageContext = {
    documentId,
    sha256: document.sha256,
    originalFilename: document.original_filename,
    attempt,
    signal: options.signal,
  };

  for (const stage of INGESTION_STAGES) {
    const cached = await sql`
      select 1 as found from raw_extractions
      where document_id = ${documentId} and stage = ${stage}
      limit 1
    `;
    if (cached.length > 0) continue; // resume: reuse prior stage output

    await sql`
      update documents set status = ${stage} where id = ${documentId}
    `;
    try {
      const payload = await stages[stage](ctx);
      await sql`
        insert into raw_extractions (document_id, stage, payload)
        values (${documentId}, ${stage}, ${sql.json(payload ?? null)})
        on conflict (document_id, stage) do nothing
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = attempt >= MAX_ATTEMPTS;
      await sql`
        update documents
        set status = ${finalAttempt ? "failed" : stage},
            stage_error = ${sql.json({ stage, message, at: now().toISOString() })}
        where id = ${documentId}
      `;
      if (finalAttempt) return { kind: "failed", stage, message };
      throw error;
    }
  }

  await sql`
    update documents set status = 'done', stage_error = null
    where id = ${documentId}
  `;
  return { kind: "done" };
}
