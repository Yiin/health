import { describe, expect, it } from "vitest";

import { isMetricName, METRIC_NAMES, METRIC_UNITS } from "./metric-names";

describe("metric-names contract", () => {
  it("pins the v1 metric names to their canonical units", () => {
    expect(METRIC_UNITS).toEqual({
      steps: "count",
      hrv_ms: "ms",
      resting_hr: "bpm",
      sleep_total_min: "min",
      sleep_deep_min: "min",
      sleep_rem_min: "min",
      sleep_light_min: "min",
      weight_kg: "kg",
    });
    expect(METRIC_NAMES).toHaveLength(Object.keys(METRIC_UNITS).length);
  });

  it("isMetricName guards unknown names", () => {
    expect(isMetricName("steps")).toBe(true);
    expect(isMetricName("banana")).toBe(false);
  });
});
