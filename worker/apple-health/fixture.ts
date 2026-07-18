// Synthetic Apple Health export.xml generator for tests. Real exports are
// far too large to commit (hundreds of MB), so the 50 MB acceptance fixture
// is GENERATED in test setup: deterministic (seeded PRNG), streamed to a temp
// file (never held whole in memory), and self-describing — the generator
// tracks the exact daily aggregates + workouts it emits, so the test can
// verify the parser/DB output against ground truth instead of a snapshot of
// thousands of rows.
//
// Not part of the worker runtime: imported by apple-health.test.ts only.

import { createWriteStream } from "node:fs";
import { once } from "node:events";

import type { MetricName } from "../../src/db/metric-names.ts";
import { METRIC_UNITS } from "../../src/db/metric-names.ts";

/** mulberry32 — tiny deterministic PRNG, so fixtures are byte-reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ExpectedMetric {
  metricOn: string;
  metric: MetricName;
  value: number;
  unit: string;
}

export interface ExpectedWorkout {
  startedAt: string;
  type: string;
  durationS: number;
  distanceM?: number;
  calories?: number;
  avgHr?: number;
  maxHr?: number;
}

export interface SyntheticExportResult {
  path: string;
  bytes: number;
  /** Keyed `${metricOn} ${metric}` → expected aggregate (parser rounding). */
  expectedMetrics: Map<string, ExpectedMetric>;
  expectedWorkouts: ExpectedWorkout[];
  recordsEmitted: number;
  /** Unmapped Record types emitted (bulk filler), with counts. */
  unmappedTypes: Record<string, number>;
}

const OFFSET = "+0300";
const OFFSET_MS = 3 * 60 * 60 * 1000;

/** epoch ms (UTC instant) → Apple timestamp "yyyy-MM-dd HH:mm:ss +0300". */
function appleTimestamp(instantMs: number): string {
  const local = new Date(instantMs + OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${day} ${time} ${OFFSET}`;
}

/** epoch ms → ISO with the +03:00 offset (what the parser produces). */
function isoTimestamp(instantMs: number): string {
  return appleTimestamp(instantMs).replace(" ", "T").replace(" +0300", "+03:00");
}

/** Local day key for an instant, matching the parser's literal-day rule. */
function dayKey(instantMs: number): string {
  return appleTimestamp(instantMs).slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * Hand-written small export covering every mapping rule: per-day step sums,
 * resting-HR averaging (two records one day), HRV, weight, a cross-midnight
 * sleep night (deep/core/rem + awake + in-bed skips + an unspecified nap that
 * feeds sleep_total_min only), a fully-nested workout and a bare one, records
 * skipped for bad dates/values, and unmapped types (plain HeartRate — not
 * resting HR — plus ActiveEnergyBurned). Shared by the parser snapshot test
 * and the extract-stage test.
 */
export const SMALL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="lt_LT">
 <ExportDate value="2024-03-16 09:00:00 +0300"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2024-03-14 10:05:00 +0300" startDate="2024-03-14 10:00:00 +0300" endDate="2024-03-14 10:05:00 +0300" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2024-03-14 11:05:00 +0300" startDate="2024-03-14 11:00:00 +0300" endDate="2024-03-14 11:05:00 +0300" value="380"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2024-03-15 11:05:00 +0300" startDate="2024-03-15 11:00:00 +0300" endDate="2024-03-15 11:05:00 +0300" value="500"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" unit="count/min" creationDate="2024-03-14 07:05:00 +0300" startDate="2024-03-14 07:00:00 +0300" endDate="2024-03-14 07:05:00 +0300" value="58"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" unit="count/min" creationDate="2024-03-14 19:05:00 +0300" startDate="2024-03-14 19:00:00 +0300" endDate="2024-03-14 19:05:00 +0300" value="62"/>
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Apple Watch" unit="ms" creationDate="2024-03-14 07:06:00 +0300" startDate="2024-03-14 07:05:00 +0300" endDate="2024-03-14 07:06:00 +0300" value="45.4"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" creationDate="2024-03-14 12:05:00 +0300" startDate="2024-03-14 12:00:00 +0300" endDate="2024-03-14 12:05:00 +0300" value="71"/>
 <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Apple Watch" unit="kcal" creationDate="2024-03-14 13:05:00 +0300" startDate="2024-03-14 13:00:00 +0300" endDate="2024-03-14 13:05:00 +0300" value="12"/>
 <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Apple Watch" unit="kcal" creationDate="2024-03-14 14:05:00 +0300" startDate="2024-03-14 14:00:00 +0300" endDate="2024-03-14 14:05:00 +0300" value="9"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Withings" unit="kg" creationDate="2024-03-14 07:10:00 +0300" startDate="2024-03-14 07:10:00 +0300" endDate="2024-03-14 07:10:00 +0300" value="70.6"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2024-03-14 10:05:00 +0300" startDate="not a date" endDate="2024-03-14 10:05:00 +0300" value="10"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2024-03-14 10:05:00 +0300" startDate="2024-03-14 12:00:00 +0300" endDate="2024-03-14 12:05:00 +0300" value="not-a-number"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-13 23:00:00 +0300" endDate="2024-03-13 23:10:00 +0300" value="HKCategoryValueSleepAnalysisInBed"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-13 23:10:00 +0300" endDate="2024-03-14 00:50:00 +0300" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-14 00:50:00 +0300" endDate="2024-03-14 02:00:00 +0300" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-14 02:00:00 +0300" endDate="2024-03-14 03:30:00 +0300" value="HKCategoryValueSleepAnalysisAsleepREM"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-14 03:30:00 +0300" endDate="2024-03-14 03:40:00 +0300" value="HKCategoryValueSleepAnalysisAwake"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 08:00:00 +0300" startDate="2024-03-14 03:40:00 +0300" endDate="2024-03-14 06:30:00 +0300" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" creationDate="2024-03-14 15:00:00 +0300" startDate="2024-03-14 14:00:00 +0300" endDate="2024-03-14 14:25:00 +0300" value="HKCategoryValueSleepAnalysisAsleepUnspecified"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32.5" durationUnit="min" totalDistance="5.21" totalDistanceUnit="km" totalEnergyBurned="352" totalEnergyBurnedUnit="kcal" sourceName="Apple Watch" sourceVersion="10.1" creationDate="2024-03-14 18:05:00 +0300" startDate="2024-03-14 17:30:00 +0300" endDate="2024-03-14 18:02:30 +0300">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="2024-03-14 17:30:00 +0300" endDate="2024-03-14 18:02:30 +0300" average="148.6" minimum="102" maximum="171.2" unit="count/min"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-03-14 17:45:00 +0300"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="10" durationUnit="min" sourceName="Apple Watch" startDate="2024-03-15 08:00:00 +0300" endDate="2024-03-15 08:10:00 +0300"/>
</HealthData>
`;

/**
 * Writes a synthetic export.xml of at least `targetBytes` to `path`.
 *
 * Shape: `days` days of records from `startDay` — 24 hourly StepCount, one
 * RestingHeartRate (two every 5th day), one HRV, a BodyMass every 7th day, a
 * 6-segment night of SleepAnalysis (deep/core/rem/core + awake + in-bed,
 * spanning midnight so stages land on the wake day) plus an unspecified nap
 * every 10th day, a Workout every 3rd day, and a bulk of unmapped HeartRate
 * filler records scaled to reach the byte target. All values come from the
 * seeded PRNG, and expected aggregates use the parser's exact rounding
 * (sums → integer, averages → 1 decimal).
 */
export async function writeSyntheticExport(
  path: string,
  options: {
    targetBytes?: number;
    seed?: number;
    days?: number;
    startDay?: string;
  } = {},
): Promise<SyntheticExportResult> {
  const targetBytes = options.targetBytes ?? 50 * 1024 * 1024;
  const rand = mulberry32(options.seed ?? 33);
  const days = options.days ?? 731; // two years
  const startMs = Date.parse(`${options.startDay ?? "2023-01-01"}T00:00:00Z`);

  const expectedMetrics = new Map<string, ExpectedMetric>();
  const expectedWorkouts: ExpectedWorkout[] = [];
  const unmappedTypes: Record<string, number> = {};
  let recordsEmitted = 0;
  let bytes = 0;

  const out = createWriteStream(path);
  async function emit(line: string): Promise<void> {
    bytes += Buffer.byteLength(line);
    if (!out.write(line)) await once(out, "drain");
  }

  // --- expected-aggregate bookkeeping (mirrors parser semantics) ---------
  const sums = new Map<string, number>();
  const avgs = new Map<string, { sum: number; count: number }>();

  function expectSum(metricOn: string, metric: MetricName, value: number) {
    const key = `${metricOn} ${metric}`;
    sums.set(key, (sums.get(key) ?? 0) + value);
    expectedMetrics.set(key, {
      metricOn,
      metric,
      value: Math.round(sums.get(key) as number),
      unit: METRIC_UNITS[metric],
    });
  }

  function expectAvg(metricOn: string, metric: MetricName, value: number) {
    const key = `${metricOn} ${metric}`;
    const acc = avgs.get(key) ?? { sum: 0, count: 0 };
    acc.sum += value;
    acc.count += 1;
    avgs.set(key, acc);
    expectedMetrics.set(key, {
      metricOn,
      metric,
      value: Math.round((acc.sum / acc.count) * 10) / 10,
      unit: METRIC_UNITS[metric],
    });
  }

  function record(
    type: string,
    startMsValue: number,
    value: string | number,
    extra = "",
  ): string {
    recordsEmitted += 1;
    const start = appleTimestamp(startMsValue);
    return `<Record type="${type}" sourceName="Apple Watch" unit="count" creationDate="${start}" startDate="${start}" endDate="${appleTimestamp(startMsValue + 5 * MIN_MS)}" value="${value}"${extra}/>\n`;
  }

  await emit(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  await emit(`<HealthData locale="lt_LT">\n`);
  await emit(
    `<ExportDate value="${appleTimestamp(startMs + days * DAY_MS)}"/>\n`,
  );

  const WORKOUT_TYPES = [
    "HKWorkoutActivityTypeRunning",
    "HKWorkoutActivityTypeWalking",
    "HKWorkoutActivityTypeCycling",
    "HKWorkoutActivityTypeTraditionalStrengthTraining",
  ];

  for (let day = 0; day < days; day++) {
    const dayStart = startMs + day * DAY_MS;
    const today = dayKey(dayStart);

    // Steps: 24 hourly records (each attributed to its own local day — late
    // evening UTC hours roll into the next day at +0300, same as the parser).
    for (let hour = 0; hour < 24; hour++) {
      const instant = dayStart + hour * 60 * MIN_MS;
      const steps = 30 + Math.floor(rand() * 150);
      await emit(record("HKQuantityTypeIdentifierStepCount", instant, steps));
      expectSum(dayKey(instant), "steps", steps);
    }

    // Resting HR: one record, two every 5th day (average per day).
    const resting1 = 50 + Math.floor(rand() * 12);
    await emit(
      record("HKQuantityTypeIdentifierRestingHeartRate", dayStart + 7 * 60 * MIN_MS, resting1),
    );
    expectAvg(today, "resting_hr", resting1);
    if (day % 5 === 0) {
      const resting2 = 50 + Math.floor(rand() * 12);
      await emit(
        record(
          "HKQuantityTypeIdentifierRestingHeartRate",
          dayStart + 19 * 60 * MIN_MS,
          resting2,
        ),
      );
      expectAvg(today, "resting_hr", resting2);
    }

    // HRV: one record with a decimal value.
    const hrv = Math.round((35 + rand() * 30) * 10) / 10;
    await emit(
      record(
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        dayStart + 7 * 60 * MIN_MS + 5 * MIN_MS,
        hrv,
      ),
    );
    expectAvg(today, "hrv_ms", hrv);

    // Weight: every 7th day.
    if (day % 7 === 0) {
      const weight = Math.round((70 + rand() * 2) * 10) / 10;
      await emit(
        record(
          "HKQuantityTypeIdentifierBodyMass",
          dayStart + 7 * 60 * MIN_MS + 10 * MIN_MS,
          weight,
        ),
      );
      expectAvg(today, "weight_kg", weight);
    }

    // Sleep: night starting 23:05, segments rolling past midnight → wake day.
    const nightStart = dayStart + 23 * 60 * MIN_MS + 5 * MIN_MS;
    const segments: Array<[string, number]> = [
      ["HKCategoryValueSleepAnalysisInBed", 8 + Math.floor(rand() * 10)], // skipped
      ["HKCategoryValueSleepAnalysisAsleepDeep", 45 + Math.floor(rand() * 30)],
      ["HKCategoryValueSleepAnalysisAsleepCore", 170 + Math.floor(rand() * 40)],
      ["HKCategoryValueSleepAnalysisAsleepREM", 80 + Math.floor(rand() * 30)],
      ["HKCategoryValueSleepAnalysisAwake", 5 + Math.floor(rand() * 15)], // skipped
      ["HKCategoryValueSleepAnalysisAsleepCore", 100 + Math.floor(rand() * 30)],
    ];
    let cursor = nightStart;
    for (const [category, minutes] of segments) {
      const end = cursor + minutes * MIN_MS;
      recordsEmitted += 1;
      await emit(
        `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" startDate="${appleTimestamp(cursor)}" endDate="${appleTimestamp(end)}" value="${category}"/>\n`,
      );
      if (category !== "HKCategoryValueSleepAnalysisInBed" && category !== "HKCategoryValueSleepAnalysisAwake") {
        const wakeDay = dayKey(end);
        expectSum(wakeDay, "sleep_total_min", minutes);
        const stage =
          category === "HKCategoryValueSleepAnalysisAsleepDeep"
            ? "sleep_deep_min"
            : category === "HKCategoryValueSleepAnalysisAsleepREM"
              ? "sleep_rem_min"
              : "sleep_light_min";
        expectSum(wakeDay, stage, minutes);
      }
      cursor = end;
    }
    // Unspecified nap every 10th day: total only, no stage.
    if (day % 10 === 0) {
      const napStart = dayStart + 14 * 60 * MIN_MS;
      const napMinutes = 20 + Math.floor(rand() * 20);
      recordsEmitted += 1;
      await emit(
        `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" startDate="${appleTimestamp(napStart)}" endDate="${appleTimestamp(napStart + napMinutes * MIN_MS)}" value="HKCategoryValueSleepAnalysisAsleepUnspecified"/>\n`,
      );
      expectSum(dayKey(napStart + napMinutes * MIN_MS), "sleep_total_min", napMinutes);
    }

    // Workout every 3rd day, with heart-rate statistics.
    if (day % 3 === 0) {
      const type = WORKOUT_TYPES[day % WORKOUT_TYPES.length];
      const start = dayStart + 17 * 60 * MIN_MS + 30 * MIN_MS;
      const durationMin = 30 + Math.floor(rand() * 30);
      const end = start + durationMin * MIN_MS;
      const isDistance = !type.includes("Strength");
      const distanceKm = isDistance
        ? Math.round((3 + rand() * 9) * 100) / 100
        : undefined;
      const calories = 200 + Math.floor(rand() * 400);
      const avgHr = 130 + Math.floor(rand() * 30);
      const maxHr = avgHr + 15 + Math.floor(rand() * 20);
      await emit(
        `<Workout workoutActivityType="${type}" duration="${durationMin}" durationUnit="min" ${isDistance ? `totalDistance="${distanceKm}" totalDistanceUnit="km" ` : ""}totalEnergyBurned="${calories}" totalEnergyBurnedUnit="kcal" sourceName="Apple Watch" startDate="${appleTimestamp(start)}" endDate="${appleTimestamp(end)}">\n`,
      );
      await emit(
        `<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="${appleTimestamp(start)}" endDate="${appleTimestamp(end)}" average="${avgHr}" minimum="${avgHr - 40}" maximum="${maxHr}" unit="count/min"/>\n`,
      );
      await emit(`</Workout>\n`);
      const shortType = type.replace("HKWorkoutActivityType", "").toLowerCase();
      expectedWorkouts.push({
        startedAt: isoTimestamp(start),
        type: shortType,
        durationS: durationMin * 60,
        ...(distanceKm !== undefined
          ? { distanceM: Math.round(distanceKm * 1000 * 100) / 100 } // parser's exact rounding
          : {}),
        calories,
        avgHr,
        maxHr,
      });
    }

    // Bulk unmapped filler (HeartRate), scaled later to reach the byte target.
    const fillerPerDay = 4; // baseline; padding loop below tops the file up
    for (let i = 0; i < fillerPerDay; i++) {
      const hr = 55 + Math.floor(rand() * 40);
      await emit(
        record(
          "HKQuantityTypeIdentifierHeartRate",
          dayStart + Math.floor(rand() * 24) * 60 * MIN_MS,
          hr,
        ),
      );
      unmappedTypes.HKQuantityTypeIdentifierHeartRate =
        (unmappedTypes.HKQuantityTypeIdentifierHeartRate ?? 0) + 1;
    }
  }

  // Pad with unmapped filler (extra day beyond the aggregate window) until
  // the byte target is reached — padding never touches expected aggregates.
  let pad = 0;
  const padDay = startMs + days * DAY_MS;
  while (bytes < targetBytes) {
    const hr = 55 + Math.floor(rand() * 40);
    await emit(
      record(
        "HKQuantityTypeIdentifierHeartRate",
        padDay + (pad % 1440) * MIN_MS,
        hr,
      ),
    );
    unmappedTypes.HKQuantityTypeIdentifierHeartRate =
      (unmappedTypes.HKQuantityTypeIdentifierHeartRate ?? 0) + 1;
    pad += 1;
  }

  await emit(`</HealthData>\n`);
  out.end();
  await once(out, "finish");

  return {
    path,
    bytes,
    expectedMetrics,
    expectedWorkouts,
    recordsEmitted,
    unmappedTypes,
  };
}
