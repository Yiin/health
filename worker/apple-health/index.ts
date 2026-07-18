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
// Apple's real distribution format is export.zip holding
// apple_health_export/export.xml. Zip bytes take a container path: the
// archive is spooled to a per-run scratch file (never buffered in RAM — the
// same move as the Takeout walker), unzipper's central-directory reader
// locates export.xml, and the decompressed entry streams into the SAME parse
// as a loose export.xml.
//
// Weird input never crashes the worker: an unreadable archive, an archive
// without export.xml, a corrupt export.xml member, non-XML and malformed XML
// all resolve to needs_review; only database errors and mid-stream I/O
// failures propagate as transient failures.

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type postgres from "postgres";
import * as unzipper from "unzipper";

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

/** The export.xml path inside Apple's export.zip (compared case-insensitively;
 * mirrors the classifier's zipMarkers in worker/classify.ts). */
export const EXPORT_XML_ENTRY = "apple_health_export/export.xml";

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
  /** Parent directory for the export.zip scratch spool; defaults to os.tmpdir(). */
  scratchRoot?: string;
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
 * Parses an Apple Health export (loose export.xml stream, or the export.zip
 * container holding apple_health_export/export.xml) and persists its rows in
 * batches. needs_review for permanent input problems (broken archive, not
 * XML, broken XML); database errors and mid-stream I/O failures propagate
 * (transient — the stage's retry machinery owns them, and re-running is
 * duplicate-free).
 */
export async function ingestAppleHealthExport(
  sql: postgres.Sql,
  source: AppleHealthXmlSource,
  options: IngestAppleHealthOptions = {},
): Promise<AppleHealthIngestOutcome> {
  const stream = await source.openStream();
  bindAbort(stream, options.signal);

  const peeked = await peekStream(stream);
  const isZip =
    peeked.head.length >= 2 &&
    peeked.head[0] === 0x50 &&
    peeked.head[1] === 0x4b;
  if (isZip) {
    return ingestFromExportZip(sql, peeked.stream, options);
  }
  return parseAndPersist(sql, peeked.stream, options);
}

/** Destroys the stream when the worker shuts down mid-parse. */
function bindAbort(stream: Readable, signal: AbortSignal | undefined): void {
  if (!signal) return;
  signal.addEventListener(
    "abort",
    () => stream.destroy(new Error("worker shutdown: parse aborted")),
    { once: true },
  );
}

/** The shared tail of both paths: parse the XML stream, persist in batches. */
async function parseAndPersist(
  sql: postgres.Sql,
  xmlStream: Readable,
  options: IngestAppleHealthOptions,
): Promise<AppleHealthIngestOutcome> {
  const checkpoint = new ProgressCheckpoint(sql, options.documentId);

  let stats: AppleHealthParseStats;
  let metrics: AppleHealthMetric[];
  try {
    const result = await parseAppleHealthXml(xmlStream, {
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

function isExportXmlEntry(path: string): boolean {
  const lower = path.toLowerCase();
  // The canonical container layout, or a bare re-zipped export.xml at the root.
  return lower === EXPORT_XML_ENTRY || lower === "export.xml";
}

/**
 * The export.zip container path: spool the archive to scratch disk (unzipper
 * needs random access and the archive can be far larger than RAM), locate
 * export.xml in the central directory, and stream the decompressed entry
 * into the shared parse.
 */
async function ingestFromExportZip(
  sql: postgres.Sql,
  zipStream: Readable,
  options: IngestAppleHealthOptions,
): Promise<AppleHealthIngestOutcome> {
  const scratch = await mkdtemp(
    join(options.scratchRoot ?? tmpdir(), "health-apple-zip-"),
  );
  try {
    const archivePath = join(scratch, "export.zip");
    await pipeline(zipStream, createWriteStream(archivePath));

    let entry: unzipper.File | undefined;
    try {
      const directory = await unzipper.Open.file(archivePath);
      entry = directory.files.find(
        (file) => file.type !== "Directory" && isExportXmlEntry(file.path),
      );
    } catch (error) {
      return {
        kind: "needs_review",
        reason: `unreadable zip archive: ${message(error)}`,
      };
    }
    if (!entry) {
      return {
        kind: "needs_review",
        reason: `zip archive has no ${EXPORT_XML_ENTRY} entry (not an Apple Health export.zip)`,
      };
    }

    // The entry decompresses from the local scratch file, so a stream error
    // during the parse is a corrupt zip member — a permanent input problem,
    // unlike source-stream (S3) errors on the loose path. Captured via the
    // error event; read through an accessor because TS narrows the captured
    // variable to null at direct read sites.
    let entryError: Error | null = null;
    const getEntryError = (): Error | null => entryError;
    const xmlStream = entry.stream();
    xmlStream.on("error", (error: Error) => {
      entryError = error;
    });
    bindAbort(xmlStream, options.signal);
    try {
      return await parseAndPersist(sql, xmlStream, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const corrupt = getEntryError();
      if (corrupt) {
        return {
          kind: "needs_review",
          reason: `corrupt zip entry ${entry.path}: ${message(corrupt)}`,
        };
      }
      throw error;
    }
  } finally {
    // Scratch cleanup is guaranteed even when the spool or parse throws.
    await rm(scratch, { recursive: true, force: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
