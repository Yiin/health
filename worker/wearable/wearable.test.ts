// Wearable CSV parser plugin tests.
//
// Pure tests: fixture snapshots, dispatch/confidence, coercion edge cases,
// and the needs_review safety net (weird input must never throw).
//
// DB tests: idempotent upsert/insert semantics against the compose Postgres
// using a worker-specific database (health_test_w28) so parallel epic workers
// never share test state. Mirrors src/db/test-utils.ts, minus the drizzle
// handle (this module persists via raw postgres.js).

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sniffCsvHeaders, toIsoDate, toNumber } from "./csv";
import {
  detectWearablePlugin,
  ingestWearableCsv,
  insertWearableWorkouts,
  parseWearableCsv,
  upsertWearableMetrics,
  WEARABLE_CONFIDENCE_THRESHOLD,
  type WearableCsvSource,
} from "./index";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/health_test_w28";

function fixtureSource(filename: string): WearableCsvSource {
  return {
    filename,
    openStream: () =>
      Promise.resolve(createReadStream(`${FIXTURES}/${filename}`)),
  };
}

function stringSource(filename: string, content: string): WearableCsvSource {
  return {
    filename,
    openStream: () => Promise.resolve(Readable.from([content])),
  };
}

describe("fixture parsing (snapshots)", () => {
  const cases: Array<[string, string]> = [
    ["google-fit-daily-activity-metrics.csv", "google_fit"],
    ["oura-sleep.csv", "oura"],
    ["whoop-physiological-cycles.csv", "whoop"],
    ["garmin-udsfile.csv", "garmin"],
  ];

  for (const [filename, plugin] of cases) {
    it(`parses ${filename} with the ${plugin} plugin`, async () => {
      const outcome = await parseWearableCsv(fixtureSource(filename));
      expect(outcome.kind).toBe("parsed");
      if (outcome.kind !== "parsed") return;
      expect(outcome.plugin).toBe(plugin);
      expect(outcome.confidence).toBeGreaterThanOrEqual(
        WEARABLE_CONFIDENCE_THRESHOLD,
      );
      expect(outcome.result.metrics.length).toBeGreaterThan(0);
      expect(outcome.result).toMatchSnapshot();
    });
  }
});

describe("detectWearablePlugin", () => {
  it("routes each fixture's headers to its own plugin", async () => {
    const expectations: Array<[string, string]> = [
      ["google-fit-daily-activity-metrics.csv", "google_fit"],
      ["oura-sleep.csv", "oura"],
      ["whoop-physiological-cycles.csv", "whoop"],
      ["garmin-udsfile.csv", "garmin"],
    ];
    for (const [filename, plugin] of expectations) {
      const headers = await sniffCsvHeaders(
        createReadStream(`${FIXTURES}/${filename}`),
      );
      const detection = detectWearablePlugin(filename, headers);
      expect(detection?.plugin.source).toBe(plugin);
    }
  });

  it("returns null below the confidence threshold", () => {
    expect(
      detectWearablePlugin("export.csv", ["foo", "bar", "baz"]),
    ).toBeNull();
    // A date column alone is not a wearable signature.
    expect(detectWearablePlugin("export.csv", ["date", "notes"])).toBeNull();
  });
});

describe("needs_review safety net", () => {
  it("flags an unrecognized CSV without throwing", async () => {
    const outcome = await parseWearableCsv(
      stringSource("random.csv", "foo,bar,baz\n1,2,3\n4,5,6\n"),
    );
    expect(outcome.kind).toBe("needs_review");
  });

  it("flags binary garbage without throwing", async () => {
    const garbage = String.fromCharCode(
      ...Array.from({ length: 512 }, (_, i) => (i * 37) % 256),
    );
    const outcome = await parseWearableCsv(stringSource("blob.csv", garbage));
    expect(outcome.kind).toBe("needs_review");
  });

  it("flags an empty file without throwing", async () => {
    const outcome = await parseWearableCsv(stringSource("empty.csv", ""));
    expect(outcome.kind).toBe("needs_review");
  });

  it("flags a stream that dies mid-read without throwing", async () => {
    const outcome = await parseWearableCsv({
      filename: "broken.csv",
      openStream: () =>
        Promise.resolve(
          new Readable({
            read() {
              this.destroy(new Error("boom"));
            },
          }),
        ),
    });
    expect(outcome.kind).toBe("needs_review");
  });
});

describe("scalar coercion", () => {
  it("coerces numbers with separators and rejects garbage", () => {
    expect(toNumber("4871")).toBe(4871);
    expect(toNumber(" 3,251.4 ")).toBe(3251.4);
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("   ")).toBeUndefined();
    expect(toNumber("n/a")).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
  });

  it("coerces ISO and US dates and rejects invalid ones", () => {
    expect(toIsoDate("2024-03-01")).toBe("2024-03-01");
    expect(toIsoDate("2024-03-01T06:58:12.000Z")).toBe("2024-03-01");
    expect(toIsoDate("3/2/2024")).toBe("2024-03-02");
    expect(toIsoDate("2024-13-40")).toBeNull();
    expect(toIsoDate("yesterday")).toBeNull();
    expect(toIsoDate("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests (compose Postgres, worker-specific health_test_w28 database)
// ---------------------------------------------------------------------------

const MIGRATION_LOCK_ID = 7282011; // same advisory lock as src/db/test-utils.ts

describe("ingestWearableCsv (database)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
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
        migrationsFolder: fileURLToPath(
          new URL("../../drizzle", import.meta.url),
        ),
      });
    } finally {
      await setup.end();
    }
    sql = postgres(TEST_DATABASE_URL);
  }, 60_000);

  afterEach(async () => {
    await sql`truncate table daily_metrics, workouts`;
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

  it("ingests all four fixtures and re-ingesting is idempotent", async () => {
    const fixtures = [
      "google-fit-daily-activity-metrics.csv",
      "oura-sleep.csv",
      "whoop-physiological-cycles.csv",
      "garmin-udsfile.csv",
    ];

    let totalMetrics = 0;
    for (const filename of fixtures) {
      const outcome = await ingestWearableCsv(sql, fixtureSource(filename));
      expect(outcome.kind).toBe("ingested");
      if (outcome.kind !== "ingested") return;
      expect(outcome.metrics).toBeGreaterThan(0);
      totalMetrics += outcome.metrics;
    }

    const firstRun = await metricRows();
    expect(firstRun).toHaveLength(totalMetrics);

    // Re-import: upserts overwrite the same keys, so the table is unchanged.
    for (const filename of fixtures) {
      const outcome = await ingestWearableCsv(sql, fixtureSource(filename));
      expect(outcome.kind).toBe("ingested");
    }
    expect(await metricRows()).toEqual(firstRun);
  });

  it("maps fixture values onto the contract units", async () => {
    await ingestWearableCsv(
      sql,
      fixtureSource("google-fit-daily-activity-metrics.csv"),
    );
    await ingestWearableCsv(sql, fixtureSource("oura-sleep.csv"));
    await ingestWearableCsv(
      sql,
      fixtureSource("whoop-physiological-cycles.csv"),
    );
    await ingestWearableCsv(sql, fixtureSource("garmin-udsfile.csv"));

    const rows = await metricRows();
    const at = (date: string, metric: string, source: string) =>
      rows.find(
        (r) =>
          r.metric_on === date && r.metric === metric && r.source === source,
      );

    expect(at("2024-03-02", "steps", "google_fit")).toMatchObject({
      value: 8123,
      unit: "count",
    });
    // Oura durations are seconds in the export, minutes in the contract.
    expect(at("2024-03-01", "sleep_total_min", "oura")).toMatchObject({
      value: 420,
      unit: "min",
    });
    expect(at("2024-03-01", "sleep_deep_min", "oura")).toMatchObject({
      value: 90,
    });
    expect(at("2024-03-01", "hrv_ms", "oura")).toMatchObject({
      value: 61,
      unit: "ms",
    });
    expect(at("2024-03-01", "resting_hr", "whoop")).toMatchObject({
      value: 52,
      unit: "bpm",
    });
    expect(at("2024-03-03", "sleep_rem_min", "whoop")).toMatchObject({
      value: 99,
      unit: "min",
    });
    expect(at("2024-03-02", "steps", "garmin")).toMatchObject({
      value: 12087,
    });
    expect(at("2024-03-02", "resting_hr", "garmin")).toMatchObject({
      value: 50,
      unit: "bpm",
    });
  });

  it("keeps per-source rows for the same day+metric", async () => {
    await ingestWearableCsv(
      sql,
      fixtureSource("google-fit-daily-activity-metrics.csv"),
    );
    await ingestWearableCsv(sql, fixtureSource("garmin-udsfile.csv"));

    const steps = (await metricRows()).filter(
      (r) => r.metric_on === "2024-03-01" && r.metric === "steps",
    );
    expect(steps.map((r) => r.source).sort()).toEqual(["garmin", "google_fit"]);
  });

  it("needs_review CSVs write no rows and never throw", async () => {
    const outcome = await ingestWearableCsv(
      sql,
      stringSource("mystery.csv", "a,b,c\n1,2,3\n"),
    );
    expect(outcome.kind).toBe("needs_review");
    expect(await metricRows()).toHaveLength(0);
  });

  it("upsertWearableMetrics is last-write-wins per source", async () => {
    const row = {
      metricOn: "2024-03-01",
      metric: "steps" as const,
      source: "google_fit",
      value: 100,
      unit: "count",
    };
    await upsertWearableMetrics(sql, [row]);
    await upsertWearableMetrics(sql, [{ ...row, value: 200 }]);
    const rows = await metricRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(200);
  });

  it("insertWearableWorkouts dedupes re-imports", async () => {
    const workout = {
      startedAt: "2024-03-01T08:30:00.000Z",
      endedAt: "2024-03-01T09:15:00.000Z",
      type: "running",
      durationS: 2700,
      distanceM: 7200,
      calories: 480,
      avgHr: 152,
      maxHr: 178,
      source: "google_fit",
      raw: { fixture: true },
    };
    await insertWearableWorkouts(sql, [workout]);
    await insertWearableWorkouts(sql, [workout]);
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from workouts
    `;
    expect(rows[0].count).toBe(1);
  });
});
