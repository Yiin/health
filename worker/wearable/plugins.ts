// Wearable CSV parser plugins: one per export source. Each plugin detects its
// own file shape (filename + header signature) and streams the CSV onto the
// daily_metrics contract (src/db/metric-names.ts) — every emitted row carries
// a contract metric name, the canonical unit, and the plugin's source string.
//
// This module runs in the worker container under plain node type stripping
// (see worker/ingestion.ts), so every relative import carries an explicit
// .ts extension and src/db/metric-names.ts is imported directly (it is
// dependency-free) rather than through the drizzle repos, whose extensionless
// import graph node cannot resolve.

import type { Readable } from "node:stream";

import { METRIC_UNITS, type MetricName } from "../../src/db/metric-names.ts";
import {
  firstCell,
  normalizeHeaders,
  normalizeRow,
  streamCsvRows,
  toIsoDate,
  toNumber,
} from "./csv.ts";

/** One daily_metrics row, contract-shaped (see src/db/repos/daily-metrics.ts). */
export interface WearableMetric {
  /** ISO date string, YYYY-MM-DD. */
  metricOn: string;
  metric: MetricName;
  /** Plugin source string (e.g. "google_fit"). */
  source: string;
  value: number;
  /** Canonical unit from METRIC_UNITS. */
  unit: string;
}

/** One workouts row (see src/db/repos/workouts.ts). */
export interface WearableWorkout {
  /** ISO timestamp. */
  startedAt: string;
  endedAt?: string;
  type: string;
  durationS?: number;
  distanceM?: number;
  calories?: number;
  avgHr?: number;
  maxHr?: number;
  source: string;
  raw?: Record<string, unknown>;
}

export interface WearableParseResult {
  metrics: WearableMetric[];
  workouts: WearableWorkout[];
}

/**
 * A parser for one wearable export family. detect() must be cheap and
 * side-effect free; parse() streams (papaparse) and must tolerate dirty cells
 * by skipping them, never by throwing.
 */
export interface WearablePlugin {
  /** daily_metrics.source / workouts.source value for every emitted row. */
  source: string;
  /** Which export file(s) this covers, for needs_review diagnostics. */
  description: string;
  /**
   * Confidence 0..1 that this file belongs to the plugin, from the filename
   * and CSV header row only. Header signatures beat filename hints.
   */
  detect(filename: string, headers: string[]): number;
  parse(stream: Readable): Promise<WearableParseResult>;
}

/** Column → contract metric mapping for one plugin. */
interface MetricMapping {
  metric: MetricName;
  /** Candidate column names, matched lowercase + trimmed. */
  columns: readonly string[];
  /** Multiplier applied to the raw value (e.g. seconds → minutes). */
  scale?: number;
}

interface HeaderSignature {
  /** Each group contributes `weight` when at least one alias is present. */
  groups: ReadonlyArray<{ weight: number; anyOf: readonly string[] }>;
  /** Substrings that add a small filename bonus when present. */
  filenameHints?: readonly string[];
  filenameBonus?: number;
}

/** Shared parse driver: date column + metric mappings → contract rows. */
function parseDailyRows(
  stream: Readable,
  source: string,
  dateColumns: readonly string[],
  mappings: readonly MetricMapping[],
): Promise<WearableParseResult> {
  const metrics: WearableMetric[] = [];
  const done = streamCsvRows(stream, (row) => {
    const normalized = normalizeRow(row);
    const metricOn = toIsoDate(firstCell(normalized, dateColumns));
    if (!metricOn) return; // no usable date → the row is not a daily aggregate
    for (const mapping of mappings) {
      const value = toNumber(firstCell(normalized, mapping.columns));
      if (value === undefined) continue;
      metrics.push({
        metricOn,
        metric: mapping.metric,
        source,
        value: mapping.scale === undefined ? value : value * mapping.scale,
        unit: METRIC_UNITS[mapping.metric],
      });
    }
  });
  return done.then(() => ({ metrics, workouts: [] }));
}

function detectFromSignature(
  filename: string,
  headers: string[],
  signature: HeaderSignature,
): number {
  const normalized = normalizeHeaders(headers);
  let confidence = 0;
  for (const group of signature.groups) {
    if (group.anyOf.some((alias) => normalized.includes(alias))) {
      confidence += group.weight;
    }
  }
  if (
    confidence > 0 &&
    signature.filenameHints?.some((hint) =>
      filename.toLowerCase().includes(hint),
    )
  ) {
    confidence += signature.filenameBonus ?? 0.05;
  }
  return Math.min(confidence, 1);
}

function defineDailyPlugin(options: {
  source: string;
  description: string;
  signature: HeaderSignature;
  dateColumns: readonly string[];
  mappings: readonly MetricMapping[];
}): WearablePlugin {
  return {
    source: options.source,
    description: options.description,
    detect: (filename, headers) =>
      detectFromSignature(filename, headers, options.signature),
    parse: (stream) =>
      parseDailyRows(
        stream,
        options.source,
        options.dateColumns,
        options.mappings,
      ),
  };
}

const SECONDS_TO_MINUTES = 1 / 60;

/**
 * Google Fit Takeout "Daily Aggregations" / "Daily activity metrics" CSVs.
 * Date may be `Date` (ISO) or `Start time` (datetime); steps appear under
 * several spellings across export generations. Heart-rate columns are
 * day-average/min/max, NOT resting HR, so they are deliberately unmapped.
 */
export const googleFitPlugin = defineDailyPlugin({
  source: "google_fit",
  description: "Google Fit Takeout daily activity metrics",
  signature: {
    groups: [
      { weight: 0.2, anyOf: ["date", "start time"] },
      { weight: 0.4, anyOf: ["step count", "steps", "total steps"] },
      {
        weight: 0.3,
        anyOf: ["calories (kcal)", "distance (m)", "move minutes count"],
      },
    ],
    filenameHints: ["daily activity metrics", "daily aggregations", "fit"],
    filenameBonus: 0.1,
  },
  dateColumns: ["date", "start time"],
  mappings: [
    { metric: "steps", columns: ["step count", "steps", "total steps"] },
  ],
});

/**
 * Oura web export CSVs (ouraring.com cloud download). The detailed sleep.csv
 * carries stage durations in SECONDS (→ minutes) and average HRV in ms;
 * daily_activity.csv carries steps. `day` is the local calendar date.
 */
export const ouraPlugin = defineDailyPlugin({
  source: "oura",
  description: "Oura export sleep/daily activity CSVs",
  signature: {
    groups: [
      { weight: 0.2, anyOf: ["day"] },
      {
        weight: 0.7,
        anyOf: [
          "total_sleep_duration",
          "deep_sleep_duration",
          "rem_sleep_duration",
          "light_sleep_duration",
        ],
      },
      {
        weight: 0.4,
        anyOf: ["steps", "average_hrv", "resting_heart_rate"],
      },
    ],
    filenameHints: ["oura", "sleep", "daily_sleep", "daily_activity"],
    filenameBonus: 0.1,
  },
  dateColumns: ["day"],
  mappings: [
    {
      metric: "sleep_total_min",
      columns: ["total_sleep_duration"],
      scale: SECONDS_TO_MINUTES,
    },
    {
      metric: "sleep_deep_min",
      columns: ["deep_sleep_duration"],
      scale: SECONDS_TO_MINUTES,
    },
    {
      metric: "sleep_rem_min",
      columns: ["rem_sleep_duration"],
      scale: SECONDS_TO_MINUTES,
    },
    {
      metric: "sleep_light_min",
      columns: ["light_sleep_duration"],
      scale: SECONDS_TO_MINUTES,
    },
    { metric: "hrv_ms", columns: ["average_hrv", "hrv"] },
    { metric: "resting_hr", columns: ["resting_heart_rate"] },
    { metric: "steps", columns: ["steps"] },
  ],
});

/**
 * Whoop account export physiological_cycles.csv: one row per 24 h cycle with
 * recovery metrics and per-night sleep durations already in minutes. The
 * cycle start date keys the day.
 */
export const whoopPlugin = defineDailyPlugin({
  source: "whoop",
  description: "Whoop physiological cycles CSV",
  signature: {
    groups: [
      { weight: 0.5, anyOf: ["cycle start time"] },
      {
        weight: 0.4,
        anyOf: [
          "recovery score %",
          "heart rate variability (ms)",
          "resting heart rate (bpm)",
        ],
      },
    ],
    filenameHints: ["whoop", "physiological_cycles"],
    filenameBonus: 0.1,
  },
  dateColumns: ["cycle start time"],
  mappings: [
    { metric: "resting_hr", columns: ["resting heart rate (bpm)"] },
    { metric: "hrv_ms", columns: ["heart rate variability (ms)"] },
    { metric: "sleep_total_min", columns: ["asleep duration (min)"] },
    { metric: "sleep_light_min", columns: ["light sleep duration (min)"] },
    { metric: "sleep_deep_min", columns: ["deep (sws) duration (min)"] },
    { metric: "sleep_rem_min", columns: ["rem duration (min)"] },
  ],
});

/**
 * Garmin account-export wellness daily summaries (UDSFile_*.csv,
 * "UserDailySummary"). `calendarDate` is ISO; stepCount and restingHeartRate
 * map onto the contract. min/max HR are day extremes, not resting HR — unmapped.
 */
export const garminPlugin = defineDailyPlugin({
  source: "garmin",
  description: "Garmin wellness daily summary CSV (UDSFile)",
  signature: {
    groups: [
      { weight: 0.3, anyOf: ["calendardate"] },
      { weight: 0.3, anyOf: ["stepcount", "totalsteps", "steps"] },
      { weight: 0.3, anyOf: ["restingheartrate", "resting heart rate"] },
    ],
    filenameHints: ["udsfile", "garmin", "wellness"],
    filenameBonus: 0.1,
  },
  dateColumns: ["calendardate", "date"],
  mappings: [
    { metric: "steps", columns: ["stepcount", "totalsteps", "steps"] },
    {
      metric: "resting_hr",
      columns: ["restingheartrate", "resting heart rate"],
    },
  ],
});

/** All plugins, highest-signature first (dispatch still scores every one). */
export const wearablePlugins: readonly WearablePlugin[] = [
  googleFitPlugin,
  ouraPlugin,
  whoopPlugin,
  garminPlugin,
];
