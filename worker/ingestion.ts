// Ingestion stage executor: walks one document through the pipeline
// classifying → extracting → normalizing → summarizing → done, RESUMING from
// persisted state. Each finished stage caches its output in raw_extractions
// (unique per document+stage), so a retried or restarted job reuses prior
// stage output
// instead of re-running it, and documents.status tracks the stage currently
// being attempted, which is what makes a mid-stage crash safe to resume.
//
// A stage may also HALT the pipeline in a terminal status (needs_review /
// ignored) by returning a payload with a `halt` field — see StageHalt — or
// PARK it in the stage's non-terminal status by throwing StagePendingError
// (the Takeout parent barrier; the job resolves without a retry and a child
// document's terminal transition re-drives the parent).
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

/**
 * Thrown by a stage to PARK the document at its current stage without failing
 * it: nothing is cached, no stage_error is recorded, and the job resolves (so
 * pg-boss schedules no retry). The document stays in the stage's non-terminal
 * status until an external event re-drives it. Used by the Takeout barrier
 * (worker/takeout.ts), which parks a parent archive at `normalizing` until
 * its child documents all reach terminal statuses — see
 * completeParentIfChildrenTerminal.
 */
export class StagePendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagePendingError";
  }
}

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
  parent_document_id: string | null;
}

export type IngestionOutcome =
  | { kind: "done" }
  | { kind: "failed"; stage: IngestionStage; message: string }
  | { kind: "halted"; stage: IngestionStage; status: string }
  | { kind: "pending"; stage: IngestionStage; message: string }
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

/**
 * Completes a parent document parked at the normalizing barrier once every
 * child is terminal (done / failed / needs_review / ignored — a failed child
 * does NOT fail its parent). The guarded UPDATE is one atomic statement, so
 * children finishing concurrently cannot double-complete the parent, and it
 * no-ops unless the parent is parked at 'normalizing' — a status the executor
 * only sets after the previous stage's payload was cached, so reaching it
 * implies fan-out finished. On completion a provenance payload is cached for
 * the barrier stage, mirroring what the barrier itself writes when it sees
 * all children terminal. Returns whether the parent was completed.
 */
export async function completeParentIfChildrenTerminal(
  sql: postgres.Sql,
  parentId: string,
  trigger: { childDocumentId: string },
): Promise<boolean> {
  // postgres.js types begin() as Promise<UnwrapPromiseArray<T>>, which does
  // not reduce back to T for a plain boolean — the runtime value is boolean.
  return sql.begin(async (tx) => {
    const completed = await tx<{ id: string }[]>`
      update documents p
      set status = 'done', stage_error = null
      where p.id = ${parentId}
        and p.status = 'normalizing'
        and not exists (
          select 1 from documents c
          where c.parent_document_id = p.id
            and c.status not in ${tx([...TERMINAL_STATUSES])}
        )
      returning p.id
    `;
    if (completed.length === 0) return false;
    await tx`
      insert into raw_extractions (document_id, stage, payload)
      values (
        ${parentId},
        'normalizing',
        ${tx.json({
          barrier: "children_terminal",
          childDocumentId: trigger.childDocumentId,
        })}
      )
      on conflict (document_id, stage) do nothing
    `;
    return true;
  }) as Promise<boolean>;
}

/**
 * Re-drives the barrier of the document's parent (if any) after the document
 * itself reached a terminal status. Runs on every terminal transition — done,
 * final-attempt failure, halt — and on jobs that find the document already
 * terminal, which covers a crash between the transition and the notification.
 */
async function notifyParentOnTerminal(
  sql: postgres.Sql,
  document: DocumentRow,
): Promise<void> {
  if (document.parent_document_id !== null) {
    await completeParentIfChildrenTerminal(sql, document.parent_document_id, {
      childDocumentId: document.id,
    });
  }
}

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
    select id, status, sha256, original_filename, parent_document_id
    from documents
    where id = ${documentId}
  `;
  const document = rows[0];
  if (!document) return { kind: "missing" };
  if (TERMINAL_STATUSES.has(document.status)) {
    await notifyParentOnTerminal(sql, document);
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
        await notifyParentOnTerminal(sql, document);
        return { kind: "halted", stage, status: halt.status };
      }
    } catch (error) {
      // A stage may PARK the run instead of failing (the Takeout barrier
      // waiting on child documents): nothing is cached, no stage_error is
      // recorded, and the job resolves — an external event re-drives the
      // document past the barrier.
      if (error instanceof StagePendingError) {
        return { kind: "pending", stage, message: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = attempt >= MAX_ATTEMPTS;
      await sql`
        update documents
        set status = ${finalAttempt ? "failed" : stage},
            stage_error = ${sql.json({ stage, message, at: now().toISOString() })}
        where id = ${documentId}
      `;
      if (finalAttempt) {
        await notifyParentOnTerminal(sql, document);
        return { kind: "failed", stage, message };
      }
      throw error;
    }
  }

  await sql`
    update documents set status = 'done', stage_error = null
    where id = ${documentId}
  `;
  await notifyParentOnTerminal(sql, document);
  return { kind: "done" };
}
