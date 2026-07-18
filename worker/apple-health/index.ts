// Apple Health export.xml ingestion: parse (worker/apple-health/parser.ts)
// then persist onto the daily_metrics / workouts contract. Like
// worker/wearable/index.ts this runs under plain node type stripping in the
// worker container, so persistence is raw postgres.js SQL mirroring the
// drizzle repos exactly — last-write-wins upsert per (metric_on, metric,
// source); workout inserts deduped by (started_at, type, source).
//
// Resume semantics: the ingestion executor (worker/ingestion.ts) re-runs the
// whole extracting stage when a job dies mid-parse — the parse restarts from
// byte zero. That is safe because every write is idempotent (upserts /
// insert-or-skip), and it is observable because a progress checkpoint row is
// upserted into raw_extractions('apple_health_progress') after every flushed
// batch: how many workouts/metrics the current (or last, crashed) run pushed
// before the stage finished. The checkpoint is an audit trail, not a resume
// cursor — a SAX stream cannot seek, so idempotent writes are the mechanism
// that prevents duplicates, which the tests verify.
//
// Weird input never crashes the worker: zip bytes (the Apple export.zip —
// archive walking is the Takeout walker's sibling feature, not this parser),
// non-XML and malformed XML resolve to needs_review; only database errors
// propagate as transient failures.

import { Readable } from "node:stream";

import type postgres from "postgres";

import {
  APPLE_HEALTH_SOURCE,
  AppleHealthXmlError,
  parseAppleHealthXml,
  type AppleHealthMetric,
  type AppleHealthParseStats,
  type AppleHealthWorkout,
} from "./parser.ts";

/** raw_extractions.stage value for the mid-stage progress checkpoint. */
export const APPLE_HEALTH_PROGRESS_STAGE = "apple_health_progress";

const INSERT_CHUNK = 500;

export interface AppleHealthXmlSource {
  filename: string;
  /** Opens a FRESH readable stream of the export.xml bytes. */
  openStream: () => Promise<Readable>;
}

export interface IngestAppleHealthOptions {
  /**
   * When set, a progress checkpoint row is upserted into raw_extractions
   * after every flushed batch (workouts during the parse, metrics at the end).
   */
  documentId?: string;
  /** Aborted on worker shutdown: destroys the input stream mid-parse. */
  signal?: AbortSignal;
  /** Workout insert batch size (per parse flush); tests shrink it. */
  workoutBatchSize?: number;
}

export type AppleHealthIngestOutcome =
  | {
      kind: "ingested";
      metrics: number;
      workouts: number;
      stats: AppleHealthParseStats;
    }
  | { kind: "needs_review"; reason: string };

/**
 * Parses an Apple Health export.xml stream and persists its rows in batches.
 * needs_review for permanent input problems (zip container, not XML, broken
 * XML); database errors and mid-stream I/O failures propagate (transient —
 * the stage's retry machinery owns them, and re-running is duplicate-free).
 */
export async function ingestAppleHealthExport(
  sql: postgres.Sql,
  source: AppleHealthXmlSource,
  options: IngestAppleHealthOptions = {},
): Promise<AppleHealthIngestOutcome> {
  const stream = await source.openStream();
  if (options.signal) {
    const signal = options.signal;
    signal.addEventListener(
      "abort",
      () => stream.destroy(new Error("worker shutdown: parse aborted")),
      { once: true },
    );
  }

  // Zip container sniff: Apple's export.zip holds apple_health_export/
  // export.xml; walking archives is a separate feature, so flag it clearly.
  const peeked = await peekStream(stream);
  if (peeked.head.length >= 2 && peeked.head[0] === 0x50 && peeked.head[1] === 0x4b) {
    return {
      kind: "needs_review",
      reason:
        "zip archive: extract apple_health_export/export.xml first (Apple Health zip walking is not implemented yet)",
    };
  }

  const checkpoint = new ProgressCheckpoint(sql, options.documentId);

  let stats: AppleHealthParseStats;
  let metrics: AppleHealthMetric[];
  try {
    const result = await parseAppleHealthXml(peeked.stream, {
      workoutBatchSize: options.workoutBatchSize,
      onWorkouts: async (batch) => {
        await insertAppleHealthWorkouts(sql, batch);
        await checkpoint.save({ workoutsFlushed: batch.length });
      },
    });
    stats = result.stats;
    metrics = result.metrics;

    await upsertAppleHealthMetrics(sql, metrics);
    await checkpoint.save({
      workoutsFlushed: 0,
      metricsFlushed: metrics.length,
      recordsSeen: stats.recordsSeen,
    });
  } catch (error) {
    if (error instanceof AppleHealthXmlError) {
      return { kind: "needs_review", reason: error.message };
    }
    throw error;
  }

  return {
    kind: "ingested",
    metrics: metrics.length,
    workouts: stats.workoutsSeen - stats.workoutsSkipped,
    stats,
  };
}

/** Upserts the raw_extractions checkpoint row (no-op without a documentId). */
class ProgressCheckpoint {
  private workoutsFlushed = 0;
  private readonly sql: postgres.Sql;
  private readonly documentId: string | undefined;

  constructor(sql: postgres.Sql, documentId: string | undefined) {
    this.sql = sql;
    this.documentId = documentId;
  }

  /** `workoutsFlushed` is a delta; metrics/records counts are absolutes. */
  async save(progress: {
    workoutsFlushed: number;
    metricsFlushed?: number;
    recordsSeen?: number;
  }): Promise<void> {
    this.workoutsFlushed += progress.workoutsFlushed;
    if (!this.documentId) return;
    const payload = {
      ...progress,
      workoutsFlushed: this.workoutsFlushed,
      source: APPLE_HEALTH_SOURCE,
      at: new Date().toISOString(),
    };
    await this.sql`
      insert into raw_extractions (document_id, stage, payload)
      values (${this.documentId}, ${APPLE_HEALTH_PROGRESS_STAGE}, ${this.sql.json(payload)})
      on conflict (document_id, stage)
      do update set payload = excluded.payload
    `;
  }
}

/**
 * Pulls the first chunk off a stream for magic-byte sniffing, then returns a
 * stream that replays it. Only the head chunk is ever held.
 */
async function peekStream(
  stream: Readable,
): Promise<{ head: Buffer; stream: Readable }> {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  async function* replay() {
    try {
      if (head.length > 0) yield head;
      let next = await iterator.next();
      while (!next.done) {
        yield next.value as Buffer;
        next = await iterator.next();
      }
    } finally {
      // Abandoning the replay (parse error, shutdown) releases the source.
      await iterator.return?.();
    }
  }
  return { head, stream: Readable.from(replay()) };
}

/**
 * Last-write-wins upsert per (metric_on, metric, source) — mirrors
 * upsertMetrics (src/db/repos/daily-metrics.ts). Aggregates are unique per
 * (day, metric) by construction, so no in-batch dedup is needed.
 */
export async function upsertAppleHealthMetrics(
  sql: postgres.Sql,
  rows: AppleHealthMetric[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const values = rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      metric_on: row.metricOn,
      metric: row.metric,
      source: row.source,
      value: row.value,
      unit: row.unit,
    }));
    await sql`
      insert into daily_metrics ${sql(values)}
      on conflict (metric_on, metric, source)
      do update set value = excluded.value
    `;
  }
}

/**
 * Insert-or-skip on (started_at, type, source) — mirrors insertWorkouts
 * (src/db/repos/workouts.ts), so re-importing the same export is a no-op.
 */
export async function insertAppleHealthWorkouts(
  sql: postgres.Sql,
  rows: AppleHealthWorkout[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const values = rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      started_at: row.startedAt,
      ended_at: row.endedAt ?? null,
      type: row.type,
      duration_s: row.durationS ?? null,
      distance_m: row.distanceM ?? null,
      calories: row.calories ?? null,
      avg_hr: row.avgHr ?? null,
      max_hr: row.maxHr ?? null,
      source: row.source,
      raw: sql.json(row.raw as postgres.JSONValue),
    }));
    await sql`
      insert into workouts ${sql(values)}
      on conflict (started_at, type, source) do nothing
    `;
  }
}
