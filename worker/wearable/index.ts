// Wearable export dispatch + persistence. The classifying stage (health-etv.13)
// hands wearable_export documents here: sniff the CSV header row, pick the
// highest-confidence parser plugin, stream-parse, and upsert onto the
// daily_metrics / workouts contract. Anything unparseable resolves to
// needs_review — weird input must never crash the worker.
//
// Persistence uses raw postgres.js SQL (not the drizzle repos in src/db) for
// the same reason worker/ingestion.ts does: the worker runs under node type
// stripping, which cannot resolve the repos' extensionless import graph. The
// SQL below mirrors the repo semantics exactly — last-write-wins upsert per
// (metric_on, metric, source); workout inserts deduped by
// (started_at, type, source).

import type { Readable } from "node:stream";

import type postgres from "postgres";

import { sniffCsvHeaders } from "./csv.ts";
import {
  wearablePlugins,
  type WearableParseResult,
  type WearablePlugin,
  type WearableWorkout,
  type WearableMetric,
} from "./plugins.ts";

/** Below this confidence a wearable_export lands in needs_review. */
export const WEARABLE_CONFIDENCE_THRESHOLD = 0.5;

export interface WearableDetection {
  plugin: WearablePlugin;
  confidence: number;
}

/**
 * Highest-confidence plugin for a file, or null when nothing clears the
 * threshold. Deterministic and side-effect free.
 */
export function detectWearablePlugin(
  filename: string,
  headers: string[],
  plugins: readonly WearablePlugin[] = wearablePlugins,
): WearableDetection | null {
  let best: WearableDetection | null = null;
  for (const plugin of plugins) {
    const raw = plugin.detect(filename, headers);
    const confidence = Math.min(Math.max(raw, 0), 1);
    if (best === null || confidence > best.confidence) {
      best = { plugin, confidence };
    }
  }
  return best !== null && best.confidence >= WEARABLE_CONFIDENCE_THRESHOLD
    ? best
    : null;
}

export type WearableParseOutcome =
  | {
      kind: "parsed";
      plugin: string;
      confidence: number;
      result: WearableParseResult;
    }
  | { kind: "needs_review"; reason: string };

export interface WearableCsvSource {
  filename: string;
  /**
   * Opens a FRESH readable stream of the CSV bytes. Called twice (header
   * sniff, then parse), so it must not return an already-consumed stream.
   */
  openStream: () => Promise<Readable>;
}

/**
 * Sniffs headers, dispatches to the winning plugin and parses. Every
 * foreseeable input problem (unreadable header, no confident plugin, parser
 * blow-up) resolves to needs_review instead of throwing; database errors are
 * NOT caught here (this function does no I/O beyond the provided streams).
 */
export async function parseWearableCsv(
  source: WearableCsvSource,
  plugins?: readonly WearablePlugin[],
): Promise<WearableParseOutcome> {
  let headers: string[];
  try {
    headers = await sniffCsvHeaders(await source.openStream());
  } catch (error) {
    return {
      kind: "needs_review",
      reason: `header read failed: ${message(error)}`,
    };
  }
  if (headers.length === 0) {
    return { kind: "needs_review", reason: "no CSV header row found" };
  }

  const detection = detectWearablePlugin(source.filename, headers, plugins);
  if (!detection) {
    const preview = headers.slice(0, 8).join(", ");
    return {
      kind: "needs_review",
      reason: `no wearable parser matched (headers: ${preview})`,
    };
  }

  try {
    const result = await detection.plugin.parse(await source.openStream());
    return {
      kind: "parsed",
      plugin: detection.plugin.source,
      confidence: detection.confidence,
      result,
    };
  } catch (error) {
    return {
      kind: "needs_review",
      reason: `${detection.plugin.source} parse failed: ${message(error)}`,
    };
  }
}

export type WearableIngestOutcome =
  | {
      kind: "ingested";
      plugin: string;
      confidence: number;
      metrics: number;
      workouts: number;
    }
  | { kind: "needs_review"; reason: string };

/**
 * Parses a wearable CSV export and persists its rows. Parse problems resolve
 * to needs_review; database errors propagate (they are transient — the
 * ingestion stage's retry machinery owns them).
 */
export async function ingestWearableCsv(
  sql: postgres.Sql,
  source: WearableCsvSource,
  plugins?: readonly WearablePlugin[],
): Promise<WearableIngestOutcome> {
  const outcome = await parseWearableCsv(source, plugins);
  if (outcome.kind === "needs_review") return outcome;
  await upsertWearableMetrics(sql, outcome.result.metrics);
  await insertWearableWorkouts(sql, outcome.result.workouts);
  return {
    kind: "ingested",
    plugin: outcome.plugin,
    confidence: outcome.confidence,
    metrics: outcome.result.metrics.length,
    workouts: outcome.result.workouts.length,
  };
}

const INSERT_CHUNK = 500;

/**
 * Last-write-wins upsert per (metric_on, metric, source) — mirrors
 * upsertMetrics (src/db/repos/daily-metrics.ts). Duplicates inside one batch
 * are collapsed first (Postgres forbids touching the same row twice in one
 * ON CONFLICT statement); the later occurrence wins, same as sequential upserts.
 */
export async function upsertWearableMetrics(
  sql: postgres.Sql,
  rows: WearableMetric[],
): Promise<void> {
  const deduped = new Map<string, WearableMetric>();
  for (const row of rows) {
    deduped.set(`${row.metricOn} ${row.metric} ${row.source}`, row);
  }
  const batch = [...deduped.values()];
  for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
    const values = batch.slice(i, i + INSERT_CHUNK).map((row) => ({
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
export async function insertWearableWorkouts(
  sql: postgres.Sql,
  rows: WearableWorkout[],
): Promise<void> {
  const deduped = new Map<string, WearableWorkout>();
  for (const row of rows) {
    const key = `${row.startedAt} ${row.type} ${row.source}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  const batch = [...deduped.values()];
  for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
    const values = batch.slice(i, i + INSERT_CHUNK).map((row) => ({
      started_at: row.startedAt,
      ended_at: row.endedAt ?? null,
      type: row.type,
      duration_s: row.durationS ?? null,
      distance_m: row.distanceM ?? null,
      calories: row.calories ?? null,
      avg_hr: row.avgHr ?? null,
      max_hr: row.maxHr ?? null,
      source: row.source,
      raw: row.raw ? sql.json(row.raw as postgres.JSONValue) : null,
    }));
    await sql`
      insert into workouts ${sql(values)}
      on conflict (started_at, type, source) do nothing
    `;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
