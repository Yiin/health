// Streaming SAX parser for Apple Health export.xml.
//
// Real exports run to hundreds of MB, so the whole document is NEVER loaded:
// the caller's Readable is pumped through the `sax` parser chunk by chunk and
// only two things accumulate in memory —
//   • per-day metric accumulators (bounded by days × mapped metrics; a decade
//     of data is a few thousand entries), because a day's final sum/average
//     needs every record of that day;
//   • at most one batch of parsed workouts (flushed via onWorkouts).
// Everything else (Record attributes, Workout children) is discarded as the
// parse walks on.
//
// <Record> mapping (onto the src/db/metric-names.ts contract):
//   HKQuantityTypeIdentifierStepCount                  → steps         (sum/day)
//   HKQuantityTypeIdentifierRestingHeartRate           → resting_hr    (avg/day)
//   HKQuantityTypeIdentifierHeartRateVariabilitySDNN   → hrv_ms        (avg/day)
//   HKQuantityTypeIdentifierBodyMass                   → weight_kg     (avg/day)
//   HKCategoryTypeIdentifierSleepAnalysis              → sleep_*_min   (sum/day)
// Plain HKQuantityTypeIdentifierHeartRate is deliberately UNMAPPED: a day
// average of all-day samples is not resting HR, same call the wearable CSV
// plugins made for Google Fit / Garmin (see worker/wearable/plugins.ts).
// Everything else (blood pressure, energy burned, ActivitySummary rings, ...)
// is counted in stats.unmappedTypes and skipped.
//
// Sleep category records become stage-minute metrics: a record's duration
// (endDate − startDate) is attributed IN FULL to the wake day (endDate's
// local day), matching how Oura/Whoop label a night. AsleepUnspecified adds
// to sleep_total_min only (no stage breakdown exists for it); InBed and Awake
// are not sleep and are skipped.
//
// <Workout> maps to one workouts row each; nested WorkoutStatistics supply
// avg/max heart rate when present, and `raw` keeps the original element
// (attributes + statistics/events/metadata) for re-processing.
//
// Day keys are taken from the literal timestamp string ("2024-01-15 08:00:00
// +0300" → "2024-01-15"), i.e. the device's local day as recorded — no
// timezone conversion ever shifts a day boundary.
//
// This module runs in the worker container under plain node type stripping
// (see worker/ingestion.ts), so relative imports carry explicit .ts
// extensions and DB access lives in ./index.ts (raw postgres.js), not here.

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import sax from "sax";

import { METRIC_UNITS, type MetricName } from "../../src/db/metric-names.ts";

/** daily_metrics.source / workouts.source for every row this parser emits. */
export const APPLE_HEALTH_SOURCE = "apple_health";

/** One daily_metrics row, contract-shaped (see src/db/repos/daily-metrics.ts). */
export interface AppleHealthMetric {
  /** ISO date string, YYYY-MM-DD (device-local day). */
  metricOn: string;
  metric: MetricName;
  source: string;
  value: number;
  /** Canonical unit from METRIC_UNITS. */
  unit: string;
}

/** One workouts row (see src/db/repos/workouts.ts). */
export interface AppleHealthWorkout {
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
  /** The original <Workout> element: attributes + nested statistics/events/metadata. */
  raw: Record<string, unknown>;
}

export interface AppleHealthParseStats {
  /** Every <Record> element seen, mapped or not. */
  recordsSeen: number;
  /** Records that produced (or updated) a daily aggregate. */
  recordsMapped: number;
  /** Records skipped for a missing/unparseable date, value or duration. */
  recordsSkipped: number;
  /** Every <Workout> element seen. */
  workoutsSeen: number;
  /** Workouts dropped (no parseable startDate). */
  workoutsSkipped: number;
  /** Unmapped Record types with their occurrence counts (debugging aid). */
  unmappedTypes: Record<string, number>;
}

export interface AppleHealthParseResult {
  metrics: AppleHealthMetric[];
  /** Workouts NOT handed to onWorkouts (all of them when no callback given). */
  workouts: AppleHealthWorkout[];
  /** Workouts delivered through onWorkouts batches. */
  workoutsFlushed: number;
  stats: AppleHealthParseStats;
}

export interface AppleHealthParseOptions {
  /**
   * Called with each full batch of parsed workouts (and once at the end with
   * the remainder). Awaited before the pump continues — natural backpressure.
   */
  onWorkouts?: (batch: AppleHealthWorkout[]) => Promise<void>;
  /** Workout flush threshold; the end-of-parse flush may be smaller. */
  workoutBatchSize?: number;
}

/** XML well-formedness / document-shape failure — permanent, not retriable. */
export class AppleHealthXmlError extends Error {}

type Aggregate = "sum" | "avg";

const RECORD_METRICS: Record<string, { metric: MetricName; aggregate: Aggregate }> = {
  HKQuantityTypeIdentifierStepCount: { metric: "steps", aggregate: "sum" },
  HKQuantityTypeIdentifierRestingHeartRate: {
    metric: "resting_hr",
    aggregate: "avg",
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    metric: "hrv_ms",
    aggregate: "avg",
  },
  HKQuantityTypeIdentifierBodyMass: { metric: "weight_kg", aggregate: "avg" },
};

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

/** SleepAnalysis category value → stage metric; absent = total-only or skip. */
const SLEEP_STAGES: Record<string, MetricName | null> = {
  HKCategoryValueSleepAnalysisAsleepCore: "sleep_light_min",
  HKCategoryValueSleepAnalysisAsleepDeep: "sleep_deep_min",
  HKCategoryValueSleepAnalysisAsleepREM: "sleep_rem_min",
  // Pre-watchOS-9 exports have no stage breakdown: total only.
  HKCategoryValueSleepAnalysisAsleepUnspecified: null,
};

/** Categories that count as asleep (contribute to sleep_total_min). */
const ASLEEP_VALUES = new Set(Object.keys(SLEEP_STAGES));

const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

/** Device-local calendar day (YYYY-MM-DD) from an Apple timestamp, or null. */
export function dayOf(appleTimestamp: string | undefined): string | null {
  if (!appleTimestamp) return null;
  const match = DAY_PATTERN.exec(appleTimestamp.trim());
  return match ? match[1] : null;
}

/**
 * Apple timestamp ("2024-01-15 08:30:00 +0300") → ISO 8601 string, or null.
 * The numeric offset is preserved, so the instant is exact.
 */
export function appleTimestampToIso(
  raw: string | undefined,
): string | null {
  if (!raw) return null;
  const text = raw.trim();
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
    text,
  );
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** "HKWorkoutActivityTypeRunning" → "running". */
export function workoutTypeOf(raw: string | undefined): string {
  const prefix = "HKWorkoutActivityType";
  const name = raw?.startsWith(prefix) ? raw.slice(prefix.length) : (raw ?? "");
  return name.toLowerCase() || "unknown";
}

const DISTANCE_TO_METERS: Record<string, number> = {
  km: 1000,
  mi: 1609.344,
  m: 1,
};

const DURATION_TO_SECONDS: Record<string, number> = {
  min: 60,
  sec: 1,
  s: 1,
  hr: 3600,
  h: 3600,
};

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function toInt(raw: string | undefined): number | undefined {
  const value = toNumber(raw);
  return value === undefined ? undefined : Math.round(value);
}

interface Accumulator {
  metricOn: string;
  metric: MetricName;
  aggregate: Aggregate;
  sum: number;
  count: number;
}

interface WorkoutBuilder {
  attributes: Record<string, string>;
  statistics: Array<Record<string, string>>;
  events: Array<Record<string, string>>;
  metadata: Record<string, string>;
}

/**
 * Stream-parses an Apple Health export.xml. Rejects with AppleHealthXmlError
 * for malformed XML or a non-HealthData root (permanent); errors from the
 * input stream itself propagate as-is (transient — the caller's retry
 * machinery owns them).
 */
export async function parseAppleHealthXml(
  stream: Readable,
  options: AppleHealthParseOptions = {},
): Promise<AppleHealthParseResult> {
  const batchSize = options.workoutBatchSize ?? 500;
  const accumulators = new Map<string, Accumulator>();
  const stats: AppleHealthParseStats = {
    recordsSeen: 0,
    recordsMapped: 0,
    recordsSkipped: 0,
    workoutsSeen: 0,
    workoutsSkipped: 0,
    unmappedTypes: {},
  };
  let pendingWorkouts: AppleHealthWorkout[] = [];
  let workoutsFlushed = 0;
  let rootElement: string | null = null;
  let depth = 0;
  let currentWorkout: WorkoutBuilder | null = null;
  let xmlError: Error | null = null;
  // Read through an accessor: sax assigns via the onerror closure, and TS
  // narrows the captured variable to null at every direct read site.
  const getXmlError = (): Error | null => xmlError;

  function accumulate(
    metricOn: string,
    metric: MetricName,
    aggregate: Aggregate,
    value: number,
  ): void {
    const key = `${metricOn} ${metric}`;
    let acc = accumulators.get(key);
    if (!acc) {
      acc = { metricOn, metric, aggregate, sum: 0, count: 0 };
      accumulators.set(key, acc);
    }
    acc.sum += value;
    acc.count += 1;
  }

  function handleRecord(attributes: Record<string, string>): void {
    stats.recordsSeen += 1;
    const type = attributes.type;

    if (type === SLEEP_TYPE) {
      handleSleepRecord(attributes);
      return;
    }

    const mapping = type ? RECORD_METRICS[type] : undefined;
    if (!mapping) {
      const label = type ?? "(missing type)";
      stats.unmappedTypes[label] = (stats.unmappedTypes[label] ?? 0) + 1;
      return;
    }

    const metricOn = dayOf(attributes.startDate);
    const value = toNumber(attributes.value);
    if (!metricOn || value === undefined) {
      stats.recordsSkipped += 1;
      return;
    }
    accumulate(metricOn, mapping.metric, mapping.aggregate, value);
    stats.recordsMapped += 1;
  }

  function handleSleepRecord(attributes: Record<string, string>): void {
    const category = attributes.value ?? "";
    if (!ASLEEP_VALUES.has(category)) return; // InBed / Awake are not sleep
    const start = Date.parse(appleTimestampToIso(attributes.startDate) ?? "");
    const end = Date.parse(appleTimestampToIso(attributes.endDate) ?? "");
    const metricOn = dayOf(attributes.endDate); // attribute the night to the wake day
    const durationMin = (end - start) / 60_000;
    if (!metricOn || !Number.isFinite(durationMin) || durationMin <= 0) {
      stats.recordsSkipped += 1;
      return;
    }
    accumulate(metricOn, "sleep_total_min", "sum", durationMin);
    const stage = SLEEP_STAGES[category];
    if (stage) accumulate(metricOn, stage, "sum", durationMin);
    stats.recordsMapped += 1;
  }

  function finishWorkout(builder: WorkoutBuilder): void {
    const attributes = builder.attributes;
    const startedAt = appleTimestampToIso(attributes.startDate);
    if (!startedAt) {
      stats.workoutsSkipped += 1;
      return;
    }
    const endedAt = appleTimestampToIso(attributes.endDate);
    const heartRate = builder.statistics.find(
      (s) => s.type === "HKQuantityTypeIdentifierHeartRate",
    );
    const durationScale =
      DURATION_TO_SECONDS[attributes.durationUnit ?? "min"] ?? 60;
    const distanceScale =
      DISTANCE_TO_METERS[attributes.totalDistanceUnit ?? "km"];
    const duration = toNumber(attributes.duration);
    const distance = toNumber(attributes.totalDistance);
    const calories = toInt(attributes.totalEnergyBurned);
    const avgHr = toInt(heartRate?.average);
    const maxHr = toInt(heartRate?.maximum);
    const raw: Record<string, unknown> = { ...attributes };
    if (builder.statistics.length > 0) raw.statistics = builder.statistics;
    if (builder.events.length > 0) raw.events = builder.events;
    if (Object.keys(builder.metadata).length > 0) raw.metadata = builder.metadata;

    pendingWorkouts.push({
      startedAt,
      ...(endedAt ? { endedAt } : {}),
      type: workoutTypeOf(attributes.workoutActivityType),
      ...(duration !== undefined
        ? { durationS: Math.round(duration * durationScale) }
        : {}),
      ...(distance !== undefined && distanceScale !== undefined
        ? { distanceM: Math.round(distance * distanceScale * 100) / 100 }
        : {}),
      ...(calories !== undefined ? { calories } : {}),
      ...(avgHr !== undefined ? { avgHr } : {}),
      ...(maxHr !== undefined ? { maxHr } : {}),
      source: APPLE_HEALTH_SOURCE,
      raw,
    });
  }

  const parser = sax.parser(true, { trim: false, normalize: false });
  parser.onerror = (error: Error) => {
    xmlError = error;
    // Strict mode parks the parser on error; resume so write() can drain and
    // the pump loop can throw the captured error from its own frame.
    parser.resume();
  };
  parser.onopentag = (node: sax.Tag) => {
    depth += 1;
    if (depth === 1) {
      rootElement = node.name;
      return;
    }
    if (currentWorkout) {
      if (node.name === "WorkoutStatistics") {
        currentWorkout.statistics.push(node.attributes);
      } else if (node.name === "WorkoutEvent") {
        currentWorkout.events.push(node.attributes);
      } else if (node.name === "MetadataEntry") {
        const key = node.attributes.key;
        if (key) currentWorkout.metadata[key] = node.attributes.value ?? "";
      }
      return;
    }
    if (node.name === "Workout") {
      stats.workoutsSeen += 1;
      currentWorkout = {
        attributes: node.attributes,
        statistics: [],
        events: [],
        metadata: {},
      };
      return;
    }
    if (node.name === "Record") {
      handleRecord(node.attributes);
    }
  };
  parser.onclosetag = (name: string) => {
    if (name === "Workout" && currentWorkout) {
      finishWorkout(currentWorkout);
      currentWorkout = null;
    }
    depth -= 1;
  };

  const decoder = new StringDecoder("utf8");
  async function flushWorkouts(final: boolean): Promise<void> {
    // Without a callback the parser accumulates all workouts and returns them
    // (small inputs/tests); big exports must pass onWorkouts for bounded memory.
    if (!options.onWorkouts) return;
    if (pendingWorkouts.length === 0) return;
    if (!final && pendingWorkouts.length < batchSize) return;
    const batch = pendingWorkouts;
    pendingWorkouts = [];
    workoutsFlushed += batch.length;
    await options.onWorkouts(batch);
  }

  try {
    for await (const chunk of stream) {
      // Streams may hand us Buffers or strings; only Buffers need the
      // incremental decoder (a string chunk is already fully decoded).
      parser.write(
        typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer),
      );
      const midStreamError = getXmlError();
      if (midStreamError) {
        throw new AppleHealthXmlError(
          `malformed XML at line ${parser.line + 1}: ${midStreamError.message}`,
        );
      }
      await flushWorkouts(false);
    }
    parser.write(decoder.end());
    parser.close();
  } catch (error) {
    // Destroying the pump stream on the way out releases the S3 socket even
    // when a flush (DB error) rather than the parse itself blew up.
    stream.destroy();
    throw error;
  }

  // parser.close() (above) surfaces an unclosed root through onerror; the
  // loop's own check only covers mid-stream failures.
  const captured = getXmlError();
  if (captured) {
    throw new AppleHealthXmlError(
      `malformed XML at line ${parser.line + 1}: ${captured.message}`,
    );
  }
  if (rootElement !== "HealthData") {
    throw new AppleHealthXmlError(
      `not an Apple Health export (root element <${rootElement ?? "none"}>, expected <HealthData>)`,
    );
  }
  await flushWorkouts(true);

  const metrics: AppleHealthMetric[] = [];
  for (const acc of accumulators.values()) {
    const value =
      acc.aggregate === "sum"
        ? Math.round(acc.sum)
        : Math.round((acc.sum / acc.count) * 10) / 10;
    metrics.push({
      metricOn: acc.metricOn,
      metric: acc.metric,
      source: APPLE_HEALTH_SOURCE,
      value,
      unit: METRIC_UNITS[acc.metric],
    });
  }
  metrics.sort((a, b) =>
    `${a.metricOn} ${a.metric}`.localeCompare(`${b.metricOn} ${b.metric}`),
  );

  return {
    metrics,
    workouts: pendingWorkouts,
    workoutsFlushed,
    stats,
  };
}
