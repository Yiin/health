// Ingestion stage executor: walks one document through the pipeline
// classifying → extracting → normalizing → summarizing → done, RESUMING from
// persisted state. Each finished stage caches its output in raw_extractions
// (unique per document+stage), so a retried or restarted job reuses prior
// stage output
// instead of re-running it, and documents.status tracks the stage currently
// being attempted, which is what makes a mid-stage crash safe to resume.
//
// A stage may also HALT the pipeline in a terminal status (needs_review /
// ignored) by returning a payload with a `halt` field — see StageHalt.
//
// The classifying stage is real (worker/classify.ts), the extracting +
// normalizing stages are real for lab_report documents (worker/extract.ts,
// worker/normalize.ts), and the summarizing stage is real for every document
// (worker/summarize.ts); non-lab documents pass through the lab stages as
// no-ops until their own stages exist.
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
  "summarizing",
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
 * Terminal stop a stage can request via its payload: the executor caches the
 * payload (raw_extractions row written as usual), then lands the document in
 * the given terminal status and ends the run WITHOUT touching later stages.
 * Used for needs_review / ignored outcomes (e.g. classifier confidence below
 * threshold, scanned PDF, extraction failing validation on every model).
 *
 * `error`, when present, is recorded into documents.stage_error (with the
 * halting stage and a timestamp) so the UI can show why the document needs
 * review; otherwise stage_error is cleared.
 */
export interface StageHalt {
  status: "needs_review" | "ignored";
  reason?: string;
  error?: string;
}

const HALT_STATUSES: ReadonlySet<string> = new Set(["needs_review", "ignored"]);

/** Reads a validated StageHalt off a stage payload's `halt` field, if any. */
export function stageHaltOf(payload: postgres.JSONValue): StageHalt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const halt = (payload as { halt?: unknown }).halt;
  if (!halt || typeof halt !== "object") return null;
  const { status, reason, error } = halt as {
    status?: unknown;
    reason?: unknown;
    error?: unknown;
  };
  if (typeof status !== "string" || !HALT_STATUSES.has(status)) return null;
  return {
    status: status as StageHalt["status"],
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

/**
 * Placeholder stages. The payload proves the stage ran and is what a resumed
 * job short-circuits on; real implementations replace these one by one.
 */
export const stubStages: Record<IngestionStage, StageRunner> = {
  classifying: async () => ({ stub: true }),
  extracting: async () => ({ stub: true }),
  normalizing: async () => ({ stub: true }),
  summarizing: async () => ({ stub: true }),
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
  | { kind: "halted"; stage: IngestionStage; status: string }
  | { kind: "skipped"; status: string }
  | { kind: "missing" };

// Statuses a job must not advance: finished runs, and failed/needs_review
// documents waiting on the retry endpoint (which resets them to `uploaded`
// before re-enqueueing).
const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "needs_review",
  "ignored",
]);

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
      // A stage may end the run in a terminal status (scanned PDF, invalid
      // extraction on every model, ...) instead of letting the pipeline
      // proceed; the halt may carry a stage_error message for the UI.
      const halt = stageHaltOf(payload);
      if (halt) {
        await sql`
          update documents
          set status = ${halt.status},
              stage_error = ${
                halt.error
                  ? sql.json({
                      stage,
                      message: halt.error,
                      at: now().toISOString(),
                    })
                  : null
              }
          where id = ${documentId}
        `;
        return { kind: "halted", stage, status: halt.status };
      }
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
