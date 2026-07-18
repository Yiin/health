// Apple Health export.xml parser + ingestion tests.
//
// Pure tests: mapping rules against a hand-written fixture (snapshot),
// workout batch flushing, malformed-XML safety, and the timestamp helpers.
//
// DB tests (compose Postgres, worker-specific health_test_w33 database — see
// worker/wearable/wearable.test.ts for the harness pattern this mirrors):
// idempotent upserts, the raw_extractions progress checkpoint, needs_review
// for zip/garbage input, and the two acceptance criteria — a 50 MB synthetic
// export parsed within a 512 MB heap with exact aggregates, and an
// interrupted parse resuming without duplicate rows.

import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SMALL_EXPORT_XML, writeSyntheticExport } from "./fixture";
import {
  APPLE_HEALTH_PROGRESS_STAGE,
  ingestAppleHealthExport,
  type AppleHealthXmlSource,
} from "./index";
import {
  APPLE_HEALTH_SOURCE,
  AppleHealthXmlError,
  appleTimestampToIso,
  dayOf,
  parseAppleHealthXml,
  workoutTypeOf,
  type AppleHealthWorkout,
} from "./parser";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/health_test_w33";

function stringSource(filename: string, content: string): AppleHealthXmlSource {
  return {
    filename,
    openStream: () => Promise.resolve(Readable.from([content])),
  };
}

// ---------------------------------------------------------------------------
// Pure parser tests
// ---------------------------------------------------------------------------

describe("parseAppleHealthXml (pure)", () => {
  it("maps the small fixture onto the contract (snapshot)", async () => {
    const result = await parseAppleHealthXml(
      Readable.from([SMALL_EXPORT_XML]),
    );
    expect(result.metrics).toMatchSnapshot();
    expect(result.workouts).toMatchSnapshot();
    expect(result.stats).toMatchSnapshot();
  });

  it("applies the documented mapping rules", async () => {
    const { metrics, stats } = await parseAppleHealthXml(
      Readable.from([SMALL_EXPORT_XML]),
    );
    const at = (day: string, metric: string) =>
      metrics.find((m) => m.metricOn === day && m.metric === metric)?.value;

    // Steps sum per day.
    expect(at("2024-03-14", "steps")).toBe(500);
    expect(at("2024-03-15", "steps")).toBe(500);
    // Resting HR averages the day's records.
    expect(at("2024-03-14", "resting_hr")).toBe(60);
    expect(at("2024-03-14", "hrv_ms")).toBe(45.4);
    expect(at("2024-03-14", "weight_kg")).toBe(70.6);
    // The night is attributed to the wake day (2024-03-14); stages sum, the
    // unspecified nap feeds the total only, in-bed/awake are dropped.
    expect(at("2024-03-14", "sleep_deep_min")).toBe(100);
    expect(at("2024-03-14", "sleep_light_min")).toBe(240);
    expect(at("2024-03-14", "sleep_rem_min")).toBe(90);
    expect(at("2024-03-14", "sleep_total_min")).toBe(455);
    // Plain HeartRate is NOT resting HR: unmapped, like the CSV plugins.
    expect(at("2024-03-14", "resting_hr")).toBe(60); // from RestingHeartRate only
    expect(stats.unmappedTypes).toEqual({
      HKQuantityTypeIdentifierHeartRate: 1,
      HKQuantityTypeIdentifierActiveEnergyBurned: 2,
    });
    // Bad date / bad value records are skipped, never fatal.
    expect(stats.recordsSkipped).toBe(2);
    expect(metrics.every((m) => m.source === APPLE_HEALTH_SOURCE)).toBe(true);
  });

  it("parses workouts with statistics, events and metadata into raw", async () => {
    const { workouts, stats } = await parseAppleHealthXml(
      Readable.from([SMALL_EXPORT_XML]),
    );
    expect(stats.workoutsSeen).toBe(2);
    expect(stats.workoutsSkipped).toBe(0);

    const [running, walking] = workouts;
    expect(running).toMatchObject({
      startedAt: "2024-03-14T17:30:00+03:00",
      endedAt: "2024-03-14T18:02:30+03:00",
      type: "running",
      durationS: 1950,
      distanceM: 5210,
      calories: 352,
      avgHr: 149,
      maxHr: 171,
      source: APPLE_HEALTH_SOURCE,
    });
    // raw keeps the original element: attributes + nested children.
    expect(running.raw).toMatchObject({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      metadata: { HKIndoorWorkout: "0" },
    });
    expect(running.raw.statistics).toHaveLength(1);
    expect(running.raw.events).toHaveLength(1);

    expect(walking).toMatchObject({
      type: "walking",
      durationS: 600,
      source: APPLE_HEALTH_SOURCE,
    });
    expect(walking.distanceM).toBeUndefined();
    expect(walking.avgHr).toBeUndefined();
  });

  it("attributes a sleep segment ending before midnight to its own end day", async () => {
    // Documented v1 rule: each SleepAnalysis record lands on the local day of
    // its endDate, so a night whose first segment ends before midnight splits
    // that segment onto the evening day (per-record, no session inference).
    const xml = `<HealthData>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-03-13 23:10:00 +0300" endDate="2024-03-13 23:55:00 +0300" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-03-13 23:55:00 +0300" endDate="2024-03-14 02:00:00 +0300" value="HKCategoryValueSleepAnalysisAsleepCore"/>
</HealthData>`;
    const { metrics } = await parseAppleHealthXml(Readable.from([xml]));
    const at = (day: string, metric: string) =>
      metrics.find((m) => m.metricOn === day && m.metric === metric)?.value;
    expect(at("2024-03-13", "sleep_deep_min")).toBe(45);
    expect(at("2024-03-13", "sleep_total_min")).toBe(45);
    expect(at("2024-03-14", "sleep_light_min")).toBe(125);
    expect(at("2024-03-14", "sleep_total_min")).toBe(125);
  });

  it("flushes workouts in batches of workoutBatchSize", async () => {
    // Split the fixture between the two <Workout> elements: the pump checks
    // the batch threshold after each chunk, so each workout flushes alone.
    const boundary = SMALL_EXPORT_XML.indexOf(
      '<Workout workoutActivityType="HKWorkoutActivityTypeWalking"',
    );
    const batches: number[] = [];
    const result = await parseAppleHealthXml(
      Readable.from([
        SMALL_EXPORT_XML.slice(0, boundary),
        SMALL_EXPORT_XML.slice(boundary),
      ]),
      {
        workoutBatchSize: 1,
        onWorkouts: async (batch: AppleHealthWorkout[]) => {
          batches.push(batch.length);
        },
      },
    );
    expect(batches).toEqual([1, 1]);
    expect(result.workoutsFlushed).toBe(2);
    expect(result.workouts).toHaveLength(0); // all delivered via the callback
  });

  it("rejects malformed XML with AppleHealthXmlError", async () => {
    await expect(
      parseAppleHealthXml(Readable.from(["<HealthData><Record</HealthData>"])),
    ).rejects.toBeInstanceOf(AppleHealthXmlError);
  });

  it("rejects non-HealthData XML", async () => {
    await expect(
      parseAppleHealthXml(Readable.from(["<html><body></body></html>"])),
    ).rejects.toThrow(/not an Apple Health export/);
  });

  it("rejects an empty file", async () => {
    await expect(parseAppleHealthXml(Readable.from([]))).rejects.toThrow(
      /not an Apple Health export/,
    );
  });
});

describe("timestamp helpers", () => {
  it("dayOf takes the literal local day", () => {
    expect(dayOf("2024-03-14 23:55:00 +0300")).toBe("2024-03-14");
    expect(dayOf("not a date")).toBeNull();
    expect(dayOf(undefined)).toBeNull();
  });

  it("appleTimestampToIso converts and preserves the offset", () => {
    expect(appleTimestampToIso("2024-03-14 17:30:00 +0300")).toBe(
      "2024-03-14T17:30:00+03:00",
    );
    expect(appleTimestampToIso("2024-03-14 17:30:00 -0500")).toBe(
      "2024-03-14T17:30:00-05:00",
    );
    expect(appleTimestampToIso("garbage")).toBeNull();
  });

  it("workoutTypeOf strips the prefix and lowercases", () => {
    expect(workoutTypeOf("HKWorkoutActivityTypeRunning")).toBe("running");
    expect(workoutTypeOf("SomethingElse")).toBe("somethingelse");
    expect(workoutTypeOf(undefined)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests (compose Postgres, worker-specific health_test_w33 database)
// ---------------------------------------------------------------------------

const MIGRATION_LOCK_ID = 7282011; // same advisory lock as src/db/test-utils.ts

/** Creates health_test_w33 if missing and applies all migrations (idempotent). */
async function migrateTestDb(): Promise<void> {
  const adminUrl = new URL(TEST_DATABASE_URL);
  const name = adminUrl.pathname.replace(/^\//, "");
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const found =
      await admin`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) {
      await admin.unsafe(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }
  const setup = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await setup.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
    await migrate(drizzle(setup), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } finally {
    await setup.end();
  }
}

describe("ingestAppleHealthExport (database)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await migrateTestDb();
    sql = postgres(TEST_DATABASE_URL);
  }, 60_000);

  afterEach(async () => {
    await sql`truncate table daily_metrics, workouts, raw_extractions, documents cascade`;
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function metricRows() {
    return sql<
      {
        metric_on: string;
        metric: string;
        source: string;
        value: number;
        unit: string;
      }[]
    >`
      select metric_on::text as metric_on, metric, source,
             value::float8 as value, unit
      from daily_metrics
      order by metric_on, metric, source
    `;
  }

  async function workoutRows() {
    return sql<
      {
        started_at: Date;
        type: string;
        duration_s: number | null;
        distance_m: number | null;
        calories: number | null;
        avg_hr: number | null;
        max_hr: number | null;
        source: string;
      }[]
    >`
      select started_at, type, duration_s, distance_m::float8 as distance_m,
             calories, avg_hr, max_hr, source
      from workouts
      order by started_at
    `;
  }

  it("ingests the small fixture and re-ingesting is idempotent", async () => {
    const source = stringSource("export.xml", SMALL_EXPORT_XML);
    const first = await ingestAppleHealthExport(sql, source);
    expect(first.kind).toBe("ingested");
    if (first.kind !== "ingested") return;
    expect(first.metrics).toBe(9);
    expect(first.workouts).toBe(2);

    const metrics = await metricRows();
    expect(metrics).toHaveLength(9);
    const at = (day: string, metric: string) =>
      metrics.find((r) => r.metric_on === day && r.metric === metric);
    expect(at("2024-03-14", "steps")).toMatchObject({ value: 500, unit: "count" });
    expect(at("2024-03-14", "sleep_total_min")).toMatchObject({
      value: 455,
      unit: "min",
    });
    expect(metrics.every((r) => r.source === APPLE_HEALTH_SOURCE)).toBe(true);

    const workouts = await workoutRows();
    expect(workouts).toHaveLength(2);
    expect(workouts[0]).toMatchObject({
      type: "running",
      duration_s: 1950,
      distance_m: 5210,
      calories: 352,
      avg_hr: 149,
      max_hr: 171,
      source: APPLE_HEALTH_SOURCE,
    });

    // Re-import: upserts overwrite the same keys, workouts conflict-skip.
    const second = await ingestAppleHealthExport(sql, source);
    expect(second.kind).toBe("ingested");
    expect(await metricRows()).toEqual(metrics);
    expect(await workoutRows()).toHaveLength(2);
  });

  it("flags a zip container as needs_review without touching the DB", async () => {
    const zipBytes = "PK\x03\x04" + "0".repeat(100);
    const outcome = await ingestAppleHealthExport(
      sql,
      stringSource("export.zip", zipBytes),
    );
    expect(outcome.kind).toBe("needs_review");
    expect(await metricRows()).toHaveLength(0);
  });

  it("flags malformed XML as needs_review", async () => {
    const outcome = await ingestAppleHealthExport(
      sql,
      stringSource("export.xml", "<HealthData><Record</HealthData>"),
    );
    expect(outcome.kind).toBe("needs_review");
    if (outcome.kind !== "needs_review") return;
    expect(outcome.reason).toMatch(/malformed XML/);
  });

  it("writes a progress checkpoint when a documentId is given", async () => {
    const doc = await sql<{ id: string }[]>`
      insert into documents (sha256, original_filename, s3_key, document_type)
      values (${crypto.randomUUID()}, 'export.xml', 'originals/x/export.xml', 'apple_health_export')
      returning id
    `;
    const documentId = doc[0].id;
    const outcome = await ingestAppleHealthExport(
      sql,
      stringSource("export.xml", SMALL_EXPORT_XML),
      { documentId, workoutBatchSize: 1 },
    );
    expect(outcome.kind).toBe("ingested");

    const rows = await sql<{ stage: string; payload: unknown }[]>`
      select stage, payload from raw_extractions where document_id = ${documentId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe(APPLE_HEALTH_PROGRESS_STAGE);
    expect(rows[0].payload).toMatchObject({
      workoutsFlushed: 2,
      metricsFlushed: 9,
      recordsSeen: 19,
      source: APPLE_HEALTH_SOURCE,
    });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: 50 MB synthetic export, bounded heap, exact aggregates, and
// duplicate-free resume after an interrupted parse.
// ---------------------------------------------------------------------------

describe("50 MB export (acceptance)", () => {
  const fixturePath = join(tmpdir(), "apple-health-export-w33.xml");
  let fixture: Awaited<ReturnType<typeof writeSyntheticExport>>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    await migrateTestDb();
    fixture = await writeSyntheticExport(fixturePath, {
      targetBytes: 50 * 1024 * 1024,
      seed: 33,
    });
    sql = postgres(TEST_DATABASE_URL);
  }, 300_000);

  afterEach(async () => {
    await sql`truncate table daily_metrics, workouts, raw_extractions, documents cascade`;
  });

  afterAll(async () => {
    await sql?.end();
    await rm(fixturePath, { force: true });
  });

  function fileSource(): AppleHealthXmlSource {
    return {
      filename: "export.xml",
      openStream: () => Promise.resolve(createReadStream(fixturePath)),
    };
  }

  /** A stream that dies mid-file, simulating an S3 socket drop. */
  function dyingSource(cutBytes: number): AppleHealthXmlSource {
    return {
      filename: "export.xml",
      openStream: async () => {
        async function* dying() {
          yield* createReadStream(fixturePath, { start: 0, end: cutBytes - 1 });
          throw new Error("simulated stream death");
        }
        return Readable.from(dying());
      },
    };
  }

  async function expectDbMatchesFixture() {
    const rows = await sql<
      { metric_on: string; metric: string; value: number; unit: string }[]
    >`
      select metric_on::text as metric_on, metric, value::float8 as value, unit
      from daily_metrics
      order by metric_on, metric
    `;
    expect(rows).toHaveLength(fixture.expectedMetrics.size);
    for (const row of rows) {
      const expected = fixture.expectedMetrics.get(
        `${row.metric_on} ${row.metric}`,
      );
      expect(expected, `unexpected row ${row.metric_on} ${row.metric}`).toBeDefined();
      expect(row.value).toBe(expected?.value);
      expect(row.unit).toBe(expected?.unit);
    }

    const workouts = await sql<
      {
        started_at: Date;
        type: string;
        duration_s: number | null;
        distance_m: number | null;
        calories: number | null;
        avg_hr: number | null;
        max_hr: number | null;
        source: string;
      }[]
    >`
      select started_at, type, duration_s, distance_m::float8 as distance_m,
             calories, avg_hr, max_hr, source
      from workouts order by started_at
    `;
    expect(workouts).toHaveLength(fixture.expectedWorkouts.length);
    workouts.forEach((row, i) => {
      const expected = fixture.expectedWorkouts[i];
      expect(row.started_at.getTime()).toBe(
        new Date(expected.startedAt).getTime(),
      );
      expect(row.type).toBe(expected.type);
      expect(row.duration_s).toBe(expected.durationS);
      expect(row.distance_m).toBe(expected.distanceM ?? null);
      expect(row.calories).toBe(expected.calories ?? null);
      expect(row.avg_hr).toBe(expected.avgHr ?? null);
      expect(row.max_hr).toBe(expected.maxHr ?? null);
      expect(row.source).toBe(APPLE_HEALTH_SOURCE);
    });
  }

  it(
    "parses within a 512 MB heap with exact aggregates (digest snapshot)",
    async () => {
      expect(fixture.bytes).toBeGreaterThanOrEqual(50 * 1024 * 1024);

      const heapBefore = process.memoryUsage().heapUsed;
      const outcome = await ingestAppleHealthExport(sql, fileSource(), {
        workoutBatchSize: 200,
      });
      const heapAfter = process.memoryUsage().heapUsed;

      expect(outcome.kind).toBe("ingested");
      if (outcome.kind !== "ingested") return;
      // The acceptance bound: whole parse + persist under a 512 MB heap…
      expect(heapAfter).toBeLessThan(512 * 1024 * 1024);
      // …and the real proof of bounded memory: the delta is accumulators
      // only, nowhere near the file size (50 MB).
      expect(heapAfter - heapBefore).toBeLessThan(128 * 1024 * 1024);

      await expectDbMatchesFixture();

      // Small digest snapshot: the full row-level truth is the exact
      // comparison above; the snapshot pins the aggregate shape.
      const digest: Record<string, { days: number; total: number }> = {};
      for (const { metric, value } of fixture.expectedMetrics.values()) {
        const entry = (digest[metric] ??= { days: 0, total: 0 });
        entry.days += 1;
        entry.total += value;
      }
      expect({
        fixtureBytes: fixture.bytes,
        metrics: digest,
        workouts: outcome.workouts,
        recordsSeen: outcome.stats.recordsSeen,
        recordsMapped: outcome.stats.recordsMapped,
        recordsSkipped: outcome.stats.recordsSkipped,
        workoutsSkipped: outcome.stats.workoutsSkipped,
        unmappedTypes: outcome.stats.unmappedTypes,
      }).toMatchSnapshot();
    },
    300_000,
  );

  it(
    "an interrupted parse resumes without duplicate rows",
    async () => {
      const cut = Math.floor(fixture.bytes * 0.4);

      // First run dies mid-stream (transient I/O failure → propagates).
      await expect(
        ingestAppleHealthExport(sql, dyingSource(cut), {
          workoutBatchSize: 200,
        }),
      ).rejects.toThrow(/simulated stream death/);

      // The partial run flushed some workouts before dying.
      const partial = await sql<{ count: number }[]>`
        select count(*)::int as count from workouts
      `;
      expect(partial[0].count).toBeGreaterThan(0);

      // Resume (the executor re-runs the stage from byte zero): no
      // duplicates — upserts + insert-or-skip make the re-run a no-op where
      // the first run already wrote.
      const outcome = await ingestAppleHealthExport(sql, fileSource(), {
        workoutBatchSize: 200,
      });
      expect(outcome.kind).toBe("ingested");

      await expectDbMatchesFixture();

      // Re-running a COMPLETED parse is a no-op too.
      const again = await ingestAppleHealthExport(sql, fileSource(), {
        workoutBatchSize: 200,
      });
      expect(again.kind).toBe("ingested");
      await expectDbMatchesFixture();
    },
    300_000,
  );
});
