// Chart-series shaping for the vitals API: split a metric's daily series into
// a raw recent window and older history, roll the older history up into
// weekly/monthly buckets (multi-year daily data would otherwise mean
// thousands of points per chart), and attach a trailing 7-day average to the
// raw window. Pure functions — no DB access — so the route handler stays thin
// and the bucketing rules are unit-testable.

export interface SeriesPoint {
  /** YYYY-MM-DD. */
  metricOn: string;
  value: number;
}

export interface DailyPoint {
  date: string;
  value: number;
  /** Trailing 7-day mean ending on `date` (fewer days at the series start). */
  avg7: number;
}

export type RollupGranularity = "week" | "month";

export interface RollupPoint {
  /** First day of the bucket (Monday for weeks, the 1st for months). */
  start: string;
  granularity: RollupGranularity;
  avg: number;
  min: number;
  max: number;
  /** Number of daily values in the bucket. */
  days: number;
}

/** How many of the most recent days stay at daily resolution. */
export const DAILY_WINDOW_DAYS = 90;

/** Older history spanning more than this rolls up monthly, not weekly. */
export const MONTHLY_SPAN_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses YYYY-MM-DD as a UTC timestamp — dates are TZ-agnostic day labels. */
function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function formatDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Splits an ascending series at `dailyWindowDays` back from its LATEST point
 * (anchored on the data, not on today — a stale series still shows its most
 * recent days raw instead of rolling everything up).
 */
export function splitDailyWindow(
  points: SeriesPoint[],
  dailyWindowDays: number = DAILY_WINDOW_DAYS,
): { daily: SeriesPoint[]; older: SeriesPoint[] } {
  if (points.length === 0) return { daily: [], older: [] };
  const latest = parseDay(points[points.length - 1].metricOn);
  const cutoff = formatDay(latest - (dailyWindowDays - 1) * DAY_MS);
  const firstDaily = points.findIndex((p) => p.metricOn >= cutoff);
  return {
    daily: points.slice(firstDaily),
    older: points.slice(0, firstDaily),
  };
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const timestamp = parseDay(day);
  const sinceMonday = (new Date(timestamp).getUTCDay() + 6) % 7;
  return formatDay(timestamp - sinceMonday * DAY_MS);
}

/** The 1st of the month containing `day`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * Picks the rollup granularity for the older history: weekly while it spans
 * under ~13 months, monthly beyond — a multi-year export stays readable.
 */
export function chooseGranularity(older: SeriesPoint[]): RollupGranularity {
  if (older.length === 0) return "week";
  const spanMs =
    parseDay(older[older.length - 1].metricOn) - parseDay(older[0].metricOn);
  return spanMs > MONTHLY_SPAN_DAYS * DAY_MS ? "month" : "week";
}

/**
 * Buckets an ascending series into weekly/monthly rollups. The bucket
 * straddling the daily window is partial — `days` says how much of it is
 * present. Bucket order follows the (ascending) input.
 */
export function rollupSeries(
  points: SeriesPoint[],
  granularity: RollupGranularity,
): RollupPoint[] {
  const buckets = new Map<
    string,
    { sum: number; min: number; max: number; days: number }
  >();
  const bucketStart = granularity === "week" ? weekStart : monthStart;
  for (const point of points) {
    const start = bucketStart(point.metricOn);
    const bucket = buckets.get(start);
    if (bucket) {
      bucket.sum += point.value;
      bucket.min = Math.min(bucket.min, point.value);
      bucket.max = Math.max(bucket.max, point.value);
      bucket.days += 1;
    } else {
      buckets.set(start, {
        sum: point.value,
        min: point.value,
        max: point.value,
        days: 1,
      });
    }
  }
  return [...buckets.entries()].map(([start, bucket]) => ({
    start,
    granularity,
    avg: round1(bucket.sum / bucket.days),
    min: bucket.min,
    max: bucket.max,
    days: bucket.days,
  }));
}

/** Attaches a trailing rolling average over the last `windowDays` values. */
export function withRollingAverage(
  points: SeriesPoint[],
  windowDays = 7,
): DailyPoint[] {
  return points.map((point, index) => {
    const from = Math.max(0, index - windowDays + 1);
    let sum = 0;
    for (let i = from; i <= index; i++) sum += points[i].value;
    return {
      date: point.metricOn,
      value: point.value,
      avg7: round1(sum / (index - from + 1)),
    };
  });
}

/**
 * The default source for a metric: the one with the freshest data, ties
 * broken alphabetically so the choice is stable between requests.
 */
export function pickDefaultSource(
  sources: { source: string; latestOn: string }[],
): string | undefined {
  let best: { source: string; latestOn: string } | undefined;
  for (const candidate of sources) {
    if (
      !best ||
      candidate.latestOn > best.latestOn ||
      (candidate.latestOn === best.latestOn && candidate.source < best.source)
    ) {
      best = candidate;
    }
  }
  return best?.source;
}

/**
 * One metric's chart payload as served by GET /api/vitals — also the type the
 * vitals client components consume (kept here so both sides share it without
 * the client importing the route module).
 */
export interface MetricSeriesPayload {
  unit: string;
  /** Every source that ever reported this metric, for the source selector. */
  sources: string[];
  /** The source `daily`/`rollups` actually came from (null when no data). */
  source: string | null;
  daily: DailyPoint[];
  rollups: RollupPoint[];
}
