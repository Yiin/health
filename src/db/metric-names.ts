// The v1 daily-metric contract: every metric stored in the daily_metrics
// table uses one of these names, and its `unit` column carries the canonical
// unit listed here. All ingestion code (wearable CSV parsers, Apple Health /
// Takeout importers) MUST normalize onto this contract — parsers convert
// source-specific names/units at the edge so the rest of the system never
// re-checks units.

/** Canonical unit for every v1 metric name. */
export const METRIC_UNITS = {
  /** Step count for the day. */
  steps: "count",
  /** Heart-rate variability. */
  hrv_ms: "ms",
  /** Resting heart rate. */
  resting_hr: "bpm",
  /** Total sleep duration. */
  sleep_total_min: "min",
  /** Deep-sleep stage duration. */
  sleep_deep_min: "min",
  /** REM-sleep stage duration. */
  sleep_rem_min: "min",
  /** Light-sleep stage duration. */
  sleep_light_min: "min",
  /** Body weight. */
  weight_kg: "kg",
} as const;

export type MetricName = keyof typeof METRIC_UNITS;

/** All v1 metric names. */
export const METRIC_NAMES = Object.keys(METRIC_UNITS) as MetricName[];

export function isMetricName(name: string): name is MetricName {
  return name in METRIC_UNITS;
}
