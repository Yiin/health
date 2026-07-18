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

import { KimiError } from "../src/lib/kimi/client.ts";

export const INGESTION_STAGES = [
  "classifying",
  "extracting",
  "normalizing",
  "summarizing",
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

/**
 * Real stage-error attempts per document: a stage failing for a reason of its
 * own (bad input, a bug, a non-retryable Kimi error) burns one of these per
 * execution; the MAX_ATTEMPTS-th failure lands the document in `failed`.
 *
 * Kimi OUTAGES (5xx / timeouts / connection failures — KimiError.retryable)
 * are counted SEPARATELY and do NOT burn these attempts: pg-boss re-runs the
 * job with its retryDelay backoff up to OUTAGE_RETRY_LIMIT extra times, so a
 * transient Moonshot incident never eats the document's real attempts. Both
 * counters live in documents.stage_error (crash-safe; reset by the retry
 * endpoint and whenever the pipeline advances to a new stage).
 */
export const MAX_ATTEMPTS = 3;

/** Outage-classed executions tolerated before the document fails anyway. */
export const OUTAGE_RETRY_LIMIT = 5;

/**
 * Upper bound on executions of one ingest job — the pg-boss retryLimit in
 * src/lib/queue.ts enqueueIngest derives from this (retryLimit =
 * MAX_JOB_EXECUTIONS - 1, since pg-boss runs a job retryLimit+1 times).
 * The executor force-fails the document when this bound is reached so a
 * document can never strand in a non-terminal status after pg-boss gives up.
 */
export const MAX_JOB_EXECUTIONS = MAX_ATTEMPTS + OUTAGE_RETRY_LIMIT;

/** A Kimi outage: the API answered 5xx/429, timed out, or was unreachable. */
export function isOutageError(error: unknown): boolean {
  return error instanceof KimiError && error.retryable;
}

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

/**
 * documents.stage_error: the last failure of the stage currently being
 * attempted, plus the two attempt counters (see MAX_ATTEMPTS). `kind` is
 * "outage" for retryable Kimi failures, "error" otherwise. Rows written
 * before the counters existed simply lack them (read as 0).
 */
export interface StageErrorRecord {
  stage: IngestionStage;
  message: string;
  at: string;
  kind?: "outage" | "error";
  errorAttempts?: number;
  outageRetries?: number;
}

interface DocumentRow {
  id: string;
  status: string;
  sha256: string;
  original_filename: string;
  parent_document_id: string | null;
  stage_error: StageErrorRecord | null;
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
 * attempt records stage_error (with per-class attempt counters — see
 * MAX_ATTEMPTS / OUTAGE_RETRY_LIMIT) and rethrows so pg-boss schedules the
 * retry with backoff; on the final attempt the document lands in `failed`
 * with a populated stage_error and the job resolves (outcome "failed"). A
 * hard non-outage failure costs exactly MAX_ATTEMPTS executions; a Kimi
 * outage costs up to OUTAGE_RETRY_LIMIT extra executions without consuming
 * any of them.
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
    select id, status, sha256, original_filename, parent_document_id,
           stage_error
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
      const outage = isOutageError(error);

      // Attempt accounting is per stage: counters accumulate in stage_error
      // across executions and reset when the pipeline reaches a new stage
      // (progress) or the retry endpoint clears stage_error. Outage-classed
      // failures increment their own counter and leave the real-attempt
      // counter alone — a Moonshot incident never burns ingestion attempts.
      const prev =
        document.stage_error && document.stage_error.stage === stage
          ? document.stage_error
          : null;
      const errorAttempts = (prev?.errorAttempts ?? 0) + (outage ? 0 : 1);
      const outageRetries = (prev?.outageRetries ?? 0) + (outage ? 1 : 0);
      const exhausted = outage
        ? outageRetries >= OUTAGE_RETRY_LIMIT
        : errorAttempts >= MAX_ATTEMPTS;
      // Backstop: pg-boss stops retrying after MAX_JOB_EXECUTIONS runs, so
      // the executor must land the document terminally by then no matter how
      // the failures were classified.
      const finalAttempt = exhausted || attempt >= MAX_JOB_EXECUTIONS;

      const recordedMessage =
        outage && finalAttempt
          ? `Kimi API unavailable after ${outageRetries} attempts with backoff ` +
            `(${message}). Real ingestion attempts were not consumed. Check ` +
            `Moonshot status and MOONSHOT_API_KEY/MOONSHOT_BASE_URL, then use ` +
            `Retry on the document once connectivity is restored.`
          : message;
      const stageError: StageErrorRecord = {
        stage,
        message: recordedMessage,
        at: now().toISOString(),
        kind: outage ? "outage" : "error",
        errorAttempts,
        outageRetries,
      };
      await sql`
        update documents
        set status = ${finalAttempt ? "failed" : stage},
            stage_error = ${sql.json({ ...stageError })}
        where id = ${documentId}
      `;
      if (finalAttempt) {
        await notifyParentOnTerminal(sql, document);
        return { kind: "failed", stage, message: recordedMessage };
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
