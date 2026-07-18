import { describe, expect, it } from "vitest";

import { dailyMetrics } from "../schema";
import { setupTestDb } from "../test-utils";
import {
  getDailySummary,
  getMetricSeries,
  upsertMetrics,
  type NewMetricRow,
} from "./daily-metrics";

const getDb = setupTestDb();

const row = (overrides: Partial<NewMetricRow> = {}): NewMetricRow => ({
  metricOn: "2026-01-10",
  metric: "steps",
  source: "google_fit",
  value: 8000,
  unit: "count",
  ...overrides,
});

describe("upsertMetrics", () => {
  it("inserts rows and reads them back as a series", async () => {
    const db = getDb();
    await upsertMetrics(db, [
      row({ metricOn: "2026-01-12", value: 10000 }),
      row({ metricOn: "2026-01-10", value: 8000 }),
      row({ metricOn: "2026-01-11", value: 9000 }),
    ]);

    const series = await getMetricSeries(db, "steps");
    expect(series.map((p) => p.metricOn)).toEqual([
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
    ]);
    expect(series[0]).toEqual({
      metricOn: "2026-01-10",
      value: 8000,
      unit: "count",
      source: "google_fit",
    });
  });

  it("is a no-op on an empty batch", async () => {
    await upsertMetrics(getDb(), []);
    expect(await getMetricSeries(getDb(), "steps")).toEqual([]);
  });

  it("re-upserting the same (date, metric, source) updates the value instead of duplicating", async () => {
    const db = getDb();
    await upsertMetrics(db, [row({ value: 8000 })]);
    await upsertMetrics(db, [row({ value: 9500 })]);

    const series = await getMetricSeries(db, "steps");
    expect(series).toHaveLength(1);
    expect(series[0].value).toBe(9500);
  });

  it("lets two sources for the same day and metric coexist", async () => {
    const db = getDb();
    await upsertMetrics(db, [
      row({ source: "google_fit", value: 8000 }),
      row({ source: "oura", value: 8200 }),
    ]);

    const series = await getMetricSeries(db, "steps");
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.source)).toEqual(["google_fit", "oura"]);
  });

  it("composite PK rejects a duplicate (date, metric, source) plain insert", async () => {
    const db = getDb();
    await db.insert(dailyMetrics).values(row());
    await expect(db.insert(dailyMetrics).values(row())).rejects.toThrow();
  });
});

describe("getMetricSeries", () => {
  it("treats from as inclusive and to as exclusive", async () => {
    const db = getDb();
    await upsertMetrics(db, [
      row({ metricOn: "2026-01-01" }),
      row({ metricOn: "2026-01-15" }),
      row({ metricOn: "2026-02-01" }),
    ]);

    expect(
      (
        await getMetricSeries(db, "steps", {
          from: "2026-01-01",
          to: "2026-02-01",
        })
      ).map((p) => p.metricOn),
    ).toEqual(["2026-01-01", "2026-01-15"]);
  });

  it("filters by source when given", async () => {
    const db = getDb();
    await upsertMetrics(db, [
      row({ source: "google_fit", value: 8000 }),
      row({ source: "oura", value: 8200 }),
    ]);

    const series = await getMetricSeries(db, "steps", { source: "oura" });
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ source: "oura", value: 8200 });
  });

  it("returns an empty array for an unknown metric", async () => {
    expect(await getMetricSeries(getDb(), "no_such_metric")).toEqual([]);
  });
});

describe("getDailySummary", () => {
  it("pivots every metric in the range by metric name", async () => {
    const db = getDb();
    await upsertMetrics(db, [
      row({ metric: "steps", metricOn: "2026-01-10", value: 8000 }),
      row({ metric: "steps", metricOn: "2026-01-11", value: 9000 }),
      row({
        metric: "resting_hr",
        metricOn: "2026-01-10",
        value: 55,
        unit: "bpm",
      }),
      row({
        metric: "sleep_deep_min",
        metricOn: "2026-01-10",
        value: 90,
        unit: "min",
        source: "oura",
      }),
      // Outside the range — must not appear.
      row({ metric: "steps", metricOn: "2026-02-01", value: 1 }),
    ]);

    const summary = await getDailySummary(db, "2026-01-01", "2026-02-01");
    expect(Object.keys(summary)).toEqual([
      "resting_hr",
      "sleep_deep_min",
      "steps",
    ]);
    expect(summary.steps.map((p) => p.metricOn)).toEqual([
      "2026-01-10",
      "2026-01-11",
    ]);
    expect(summary.resting_hr[0]).toMatchObject({ value: 55, unit: "bpm" });
    expect(summary.sleep_deep_min[0]).toMatchObject({
      value: 90,
      source: "oura",
    });
  });

  it("returns an empty object when nothing is in range", async () => {
    const db = getDb();
    await upsertMetrics(db, [row({ metricOn: "2026-01-10" })]);
    expect(await getDailySummary(db, "2026-02-01", "2026-03-01")).toEqual({});
  });
});
