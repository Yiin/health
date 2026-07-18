// Ingestion health snapshot: pg-boss queue depth + document status counts.
// Served by GET /api/ingestion/health and shown on the upload page; the
// runbook in README.md leans on it (a growing failed count or a deep queue is
// the "go look at the worker" signal).

import type postgres from "postgres";

import { NON_TERMINAL_STATUSES } from "../db/schema";

/** Queue name; mirrors INGEST_JOB in src/lib/queue.ts. */
const INGEST_QUEUE = "ingest";

export interface IngestionHealth {
  queue: {
    /** Jobs waiting to run (pg-boss states created + retry). */
    queued: number;
    /** Jobs a worker is executing right now. */
    active: number;
  };
  documents: {
    /** Mid-pipeline documents (uploaded/classifying/…/summarizing). */
    processing: number;
    failed: number;
    needsReview: number;
  };
}

/**
 * Counts are read straight from Postgres — no pg-boss instance is started.
 * The pgboss schema is created by the first boss.start(); until then (fresh
 * database, worker never booted) queue counts read as zero rather than
 * erroring, so the endpoint is safe to probe at any point of the stack's
 * lifecycle.
 */
export async function getIngestionHealth(
  sql: postgres.Sql,
): Promise<IngestionHealth> {
  const [{ exists: queueTableExists }] = await sql<{ exists: boolean }[]>`
    select to_regclass('pgboss.job') is not null as exists
  `;

  let queued = 0;
  let active = 0;
  if (queueTableExists) {
    const [row] = await sql<{ queued: number; active: number }[]>`
      select
        count(*) filter (where state in ('created', 'retry'))::int as queued,
        count(*) filter (where state = 'active')::int as active
      from pgboss.job
      where name = ${INGEST_QUEUE}
    `;
    queued = row.queued;
    active = row.active;
  }

  const [docs] = await sql<
    { processing: number; failed: number; needs_review: number }[]
  >`
    select
      count(*) filter (where status in ${sql([...NON_TERMINAL_STATUSES])})::int
        as processing,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'needs_review')::int as needs_review
    from documents
  `;

  return {
    queue: { queued, active },
    documents: {
      processing: docs.processing,
      failed: docs.failed,
      needsReview: docs.needs_review,
    },
  };
}
