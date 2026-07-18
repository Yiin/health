import { describe, expect, it } from "vitest";

import {
  chooseGranularity,
  monthStart,
  pickDefaultSource,
  rollupSeries,
  splitDailyWindow,
  weekStart,
  withRollingAverage,
  type SeriesPoint,
} from "./vitals";

const points = (days: string[], value = 10): SeriesPoint[] =>
  days.map((metricOn) => ({ metricOn, value }));

describe("splitDailyWindow", () => {
  it("anchors the 90-day raw window on the latest point, not on today", () => {
    const series = points([
      "2025-01-01", // older
      "2025-10-03", // 89 days before the latest — raw
      "2025-12-31", // latest
    ]);
    const { daily, older } = splitDailyWindow(series);
    expect(daily.map((p) => p.metricOn)).toEqual(["2025-10-03", "2025-12-31"]);
    expect(older.map((p) => p.metricOn)).toEqual(["2025-01-01"]);
  });

  it("puts the day just outside the window into the rollup input", () => {
    // 2025-10-02 is 90 days before 2025-12-31, i.e. outside the 90-day window.
    const series = points(["2025-10-02", "2025-12-31"]);
    const { daily, older } = splitDailyWindow(series);
    expect(daily.map((p) => p.metricOn)).toEqual(["2025-12-31"]);
    expect(older.map((p) => p.metricOn)).toEqual(["2025-10-02"]);
  });

  it("keeps everything raw when the series is shorter than the window", () => {
    const series = points(["2026-01-01", "2026-01-02"]);
    const { daily, older } = splitDailyWindow(series);
    expect(daily).toHaveLength(2);
    expect(older).toEqual([]);
  });

  it("handles an empty series", () => {
    expect(splitDailyWindow([])).toEqual({ daily: [], older: [] });
  });
});

describe("weekStart", () => {
  it.each([
    ["2026-01-12", "2026-01-12"], // Monday → itself
    ["2026-01-13", "2026-01-12"], // Tuesday
    ["2026-01-18", "2026-01-12"], // Sunday → same week's Monday
    ["2026-01-11", "2026-01-05"], // Sunday belongs to the week that STARTED
    ["2026-01-01", "2025-12-29"], // year boundary
  ])("%s → %s", (day, expected) => {
    expect(weekStart(day)).toBe(expected);
  });
});

describe("monthStart", () => {
  it("snaps to the 1st", () => {
    expect(monthStart("2026-03-17")).toBe("2026-03-01");
  });
});

describe("chooseGranularity", () => {
  it("picks weekly for short history, monthly beyond ~13 months", () => {
    expect(chooseGranularity(points(["2025-01-01", "2025-12-31"]))).toBe(
      "week",
    );
    expect(chooseGranularity(points(["2024-01-01", "2026-01-01"]))).toBe(
      "month",
    );
  });

  it("defaults to weekly for empty input", () => {
    expect(chooseGranularity([])).toBe("week");
  });
});

describe("rollupSeries", () => {
  it("averages into ISO-week buckets with min/max and day counts", () => {
    const series: SeriesPoint[] = [
      { metricOn: "2026-01-12", value: 6 }, // week of Jan 12
      { metricOn: "2026-01-13", value: 12 }, // week of Jan 12
      { metricOn: "2026-01-19", value: 30 }, // week of Jan 19
    ];
    expect(rollupSeries(series, "week")).toEqual([
      {
        start: "2026-01-12",
        granularity: "week",
        avg: 9,
        min: 6,
        max: 12,
        days: 2,
      },
      {
        start: "2026-01-19",
        granularity: "week",
        avg: 30,
        min: 30,
        max: 30,
        days: 1,
      },
    ]);
  });

  it("averages into calendar-month buckets", () => {
    const series: SeriesPoint[] = [
      { metricOn: "2026-01-30", value: 10 },
      { metricOn: "2026-02-01", value: 20 },
      { metricOn: "2026-02-02", value: 40 },
    ];
    expect(rollupSeries(series, "month")).toEqual([
      {
        start: "2026-01-01",
        granularity: "month",
        avg: 10,
        min: 10,
        max: 10,
        days: 1,
      },
      {
        start: "2026-02-01",
        granularity: "month",
        avg: 30,
        min: 20,
        max: 40,
        days: 2,
      },
    ]);
  });

  it("rounds averages to one decimal", () => {
    const series: SeriesPoint[] = [
      { metricOn: "2026-01-12", value: 1 },
      { metricOn: "2026-01-13", value: 2 },
    ];
    expect(rollupSeries(series, "week")[0].avg).toBe(1.5);
  });

  it("returns an empty array for empty input", () => {
    expect(rollupSeries([], "week")).toEqual([]);
  });
});

describe("withRollingAverage", () => {
  it("computes a trailing 7-day mean, warming up over the first points", () => {
    const series: SeriesPoint[] = Array.from({ length: 8 }, (_, i) => ({
      metricOn: `2026-01-0${i + 1}`,
      value: (i + 1) * 10,
    }));
    const result = withRollingAverage(series);
    expect(result[0]).toEqual({ date: "2026-01-01", value: 10, avg7: 10 });
    expect(result[1].avg7).toBe(15); // (10+20)/2
    expect(result[6].avg7).toBe(40); // (10+...+70)/7
    expect(result[7].avg7).toBe(50); // (20+...+80)/7 — window slides
  });

  it("keeps the raw value alongside the average", () => {
    const result = withRollingAverage([{ metricOn: "2026-01-01", value: 42 }]);
    expect(result[0]).toEqual({ date: "2026-01-01", value: 42, avg7: 42 });
  });
});

describe("pickDefaultSource", () => {
  it("picks the source with the freshest data", () => {
    expect(
      pickDefaultSource([
        { source: "garmin", latestOn: "2025-06-01" },
        { source: "oura", latestOn: "2026-01-01" },
      ]),
    ).toBe("oura");
  });

  it("breaks ties alphabetically for a stable default", () => {
    expect(
      pickDefaultSource([
        { source: "oura", latestOn: "2026-01-01" },
        { source: "garmin", latestOn: "2026-01-01" },
      ]),
    ).toBe("garmin");
  });

  it("returns undefined when no source reported the metric", () => {
    expect(pickDefaultSource([])).toBeUndefined();
  });
});
