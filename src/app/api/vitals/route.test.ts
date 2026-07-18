import { describe, expect, it } from "vitest";

import { upsertMetrics, type NewMetricRow } from "@/db/repos/daily-metrics";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";

import { GET } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

const row = (overrides: Partial<NewMetricRow> = {}): NewMetricRow => ({
  metricOn: "2025-07-10",
  metric: "steps",
  source: "google_fit",
  value: 8000,
  unit: "count",
  ...overrides,
});

function getVitals(query: string) {
  return GET(new Request(`http://localhost/api/vitals${query}`));
}

/** ~15 months of weekly steps plus 10 recent daily steps (google_fit). */
async function seedSteps() {
  const rows: NewMetricRow[] = [];
  let day = new Date("2024-01-01T00:00:00Z");
  // Stop before the 90-day daily window anchored on 2025-07-10 (cutoff
  // 2025-04-12) so the weekly history and the daily points never overlap.
  const end = new Date("2025-04-07T00:00:00Z");
  for (let i = 0; day <= end; i++) {
    rows.push(
      row({
        metricOn: day.toISOString().slice(0, 10),
        value: 5000 + (i % 500),
      }),
    );
    day = new Date(day.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  for (let d = 1; d <= 10; d++) {
    rows.push(row({ metricOn: `2025-07-${String(d).padStart(2, "0")}` }));
  }
  await upsertMetrics(getDb(), rows);
}

interface MetricPayload {
  unit: string;
  sources: string[];
  source: string | null;
  daily: { date: string; value: number; avg7: number }[];
  rollups: {
    start: string;
    granularity: "week" | "month";
    avg: number;
    min: number;
    max: number;
    days: number;
  }[];
}

async function vitalsJson(query: string) {
  const response = await getVitals(query);
  return {
    status: response.status,
    body: (await response.json()) as {
      metrics?: Record<string, MetricPayload>;
      error?: string;
    },
  };
}

describe("GET /api/vitals", () => {
  it("rejects a missing metric param", async () => {
    const { status, body } = await vitalsJson("");
    expect(status).toBe(400);
    expect(body.error).toMatch(/metric/);
  });

  it("rejects unknown metric names", async () => {
    const { status, body } = await vitalsJson("?metric=steps,vo2max");
    expect(status).toBe(400);
    expect(body.error).toMatch(/vo2max/);
  });

  it("rejects malformed from/to dates", async () => {
    expect((await vitalsJson("?metric=steps&from=2025-1-1")).status).toBe(400);
    expect((await vitalsJson("?metric=steps&to=yesterday")).status).toBe(400);
  });

  it("splits the series into a raw 90-day window and monthly rollups", async () => {
    await seedSteps();
    const { status, body } = await vitalsJson("?metric=steps");
    expect(status).toBe(200);
    const payload = body.metrics!.steps;
    expect(payload.unit).toBe("count");
    expect(payload.source).toBe("google_fit");
    // The 10 seeded daily points are the only ones inside the 90-day window
    // anchored on 2025-07-10.
    expect(payload.daily).toHaveLength(10);
    expect(payload.daily[0].date).toBe("2025-07-01");
    expect(payload.daily[9].avg7).toBe(8000);
    // ~15 months of older history rolls up monthly (Jan 2024 – Apr 2025),
    // Jan 2024 first with its five Mondays.
    expect(payload.rollups).toHaveLength(16);
    expect(payload.rollups[0]).toMatchObject({
      start: "2024-01-01",
      granularity: "month",
      days: 5,
    });
    // No raw points leak: every rollup predates the daily window.
    for (const rollup of payload.rollups) {
      expect(rollup.start < "2025-04-12").toBe(true);
    }
  });

  it("rolls up weekly when the older history spans under ~13 months", async () => {
    const rows: NewMetricRow[] = [];
    for (let d = 1; d <= 28; d++) {
      rows.push(
        row({
          metric: "resting_hr",
          source: "oura",
          unit: "bpm",
          metricOn: `2025-06-${String(d).padStart(2, "0")}`,
          value: 55,
        }),
      );
    }
    await upsertMetrics(getDb(), rows);
    const { body } = await vitalsJson("?metric=resting_hr");
    const payload = body.metrics!.resting_hr;
    // Latest is 2025-06-28 → 90-day window starts 2025-03-31, so nothing is
    // older; add nothing to rollups. All raw.
    expect(payload.rollups).toEqual([]);
    expect(payload.daily).toHaveLength(28);
  });

  it("lists sources and defaults to the freshest one", async () => {
    await seedSteps();
    await upsertMetrics(getDb(), [
      row({ source: "garmin", metricOn: "2024-06-01", value: 8100 }),
    ]);
    const { body } = await vitalsJson("?metric=steps");
    const payload = body.metrics!.steps;
    expect(payload.sources).toEqual(["garmin", "google_fit"]);
    expect(payload.source).toBe("google_fit");
  });

  it("honors an explicit source, anchoring the window on that series", async () => {
    await seedSteps();
    await upsertMetrics(getDb(), [
      row({ source: "garmin", metricOn: "2024-06-01", value: 8100 }),
    ]);
    const { body } = await vitalsJson("?metric=steps&source=garmin");
    const payload = body.metrics!.steps;
    expect(payload.source).toBe("garmin");
    // Garmin's only point is its own latest, so it stays raw.
    expect(payload.daily).toEqual([
      { date: "2024-06-01", value: 8100, avg7: 8100 },
    ]);
    expect(payload.rollups).toEqual([]);
  });

  it("falls back to the default source for an unknown source param", async () => {
    await seedSteps();
    const { body } = await vitalsJson("?metric=steps&source=fitbit");
    expect(body.metrics!.steps.source).toBe("google_fit");
  });

  it("returns every requested metric keyed by name", async () => {
    await seedSteps();
    await upsertMetrics(getDb(), [
      row({
        metric: "hrv_ms",
        source: "oura",
        unit: "ms",
        metricOn: "2025-07-09",
        value: 62,
      }),
    ]);
    const { body } = await vitalsJson("?metric=steps,hrv_ms");
    expect(Object.keys(body.metrics!)).toEqual(["steps", "hrv_ms"]);
    expect(body.metrics!.hrv_ms).toMatchObject({
      unit: "ms",
      source: "oura",
    });
  });

  it("returns an empty payload for a metric nobody reported", async () => {
    const { status, body } = await vitalsJson("?metric=weight_kg");
    expect(status).toBe(200);
    expect(body.metrics!.weight_kg).toEqual({
      unit: "kg",
      sources: [],
      source: null,
      daily: [],
      rollups: [],
    });
  });

  it("bounds the series with from/to", async () => {
    await seedSteps();
    const { body } = await vitalsJson(
      "?metric=steps&from=2025-07-05&to=2025-07-08",
    );
    const payload = body.metrics!.steps;
    expect(payload.daily.map((p) => p.date)).toEqual([
      "2025-07-05",
      "2025-07-06",
      "2025-07-07",
    ]);
    expect(payload.rollups).toEqual([]);
  });
});
