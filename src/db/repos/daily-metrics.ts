// Repository for daily_metrics: upsert (last write wins per source), single-
// metric series, and range summaries pivoted by metric name. Pure functions
// taking the drizzle db handle as their first argument — no module-level
// state, so they work with both the app singleton (src/db/index.ts) and test
// databases.

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { dailyMetrics } from "../schema";
import type * as schema from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

/** One metric value for one day from one source. */
export interface NewMetricRow {
  /** ISO date string, YYYY-MM-DD. */
  metricOn: string;
  /** Contract name from src/db/metric-names.ts (e.g. "steps"). */
  metric: string;
  /** Ingestion source (e.g. "google_fit", "oura"). */
  source: string;
  value: number;
  /** Canonical unit for the metric (see METRIC_UNITS). */
  unit: string;
}

/**
 * Persists metric rows. On (metric_on, metric, source) conflict the value is
 * overwritten — last write wins PER SOURCE. Different sources for the same
 * day+metric keep separate rows (cross-source dedup is deliberately out of
 * scope; the UI picks a preferred source).
 */
export async function upsertMetrics(
  db: Db,
  rows: NewMetricRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(dailyMetrics)
    .values(rows)
    .onConflictDoUpdate({
      target: [dailyMetrics.metricOn, dailyMetrics.metric, dailyMetrics.source],
      set: { value: sql`excluded.value` },
    });
}

export interface MetricPoint {
  metricOn: string;
  value: number;
  unit: string;
  source: string;
}

/**
 * Ascending series for one metric. `from` is inclusive, `to` exclusive;
 * `source` narrows to a single source. With no source filter, days reported
 * by several sources appear once per source (ordered by metric_on, source).
 */
export async function getMetricSeries(
  db: Db,
  metric: string,
  range: { from?: string; to?: string; source?: string } = {},
): Promise<MetricPoint[]> {
  const conditions = [eq(dailyMetrics.metric, metric)];
  if (range.from) conditions.push(gte(dailyMetrics.metricOn, range.from));
  if (range.to) conditions.push(lt(dailyMetrics.metricOn, range.to));
  if (range.source) conditions.push(eq(dailyMetrics.source, range.source));

  return db
    .select({
      metricOn: dailyMetrics.metricOn,
      value: dailyMetrics.value,
      unit: dailyMetrics.unit,
      source: dailyMetrics.source,
    })
    .from(dailyMetrics)
    .where(and(...conditions))
    .orderBy(asc(dailyMetrics.metricOn), asc(dailyMetrics.source));
}

/** Every metric in a range, keyed by metric name (chart input). */
export type DailySummary = Record<string, MetricPoint[]>;

/**
 * All metrics with `from <= metric_on < to`, pivoted by metric name: each
 * key holds that metric's ascending series (all sources).
 */
export async function getDailySummary(
  db: Db,
  from: string,
  to: string,
): Promise<DailySummary> {
  const rows = await db
    .select()
    .from(dailyMetrics)
    .where(and(gte(dailyMetrics.metricOn, from), lt(dailyMetrics.metricOn, to)))
    .orderBy(
      asc(dailyMetrics.metric),
      asc(dailyMetrics.metricOn),
      asc(dailyMetrics.source),
    );

  const summary: DailySummary = {};
  for (const row of rows) {
    (summary[row.metric] ??= []).push({
      metricOn: row.metricOn,
      value: row.value,
      unit: row.unit,
      source: row.source,
    });
  }
  return summary;
}

export interface MetricSourceInfo {
  source: string;
  /** Most recent day this source reported the metric, YYYY-MM-DD. */
  latestOn: string;
}

/**
 * Every source that has ever reported `metric`, with each source's most
 * recent day — the input for the vitals UI's source selector and its default
 * source pick (freshest data wins).
 */
export async function getMetricSources(
  db: Db,
  metric: string,
): Promise<MetricSourceInfo[]> {
  return db
    .select({
      source: dailyMetrics.source,
      latestOn: sql<string>`max(${dailyMetrics.metricOn})`,
    })
    .from(dailyMetrics)
    .where(eq(dailyMetrics.metric, metric))
    .groupBy(dailyMetrics.source)
    .orderBy(asc(dailyMetrics.source));
}
