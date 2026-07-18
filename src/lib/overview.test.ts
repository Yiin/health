import { describe, expect, it } from "vitest";

import type { LatestMetricValue } from "@/db/repos/daily-metrics";

import type { InRangeSummary } from "./attention";
import { buildStatCards, formatMetricValue } from "./overview";

function metric(
  name: string,
  value: number,
  metricOn = "2026-07-15",
): LatestMetricValue {
  return { metric: name, metricOn, value, unit: "", source: "oura" };
}

const NO_LABS: InRangeSummary = {
  measured: 0,
  inRange: 0,
  outOfRange: 0,
  unknown: 0,
};

describe("formatMetricValue", () => {
  it("formats sleep minutes as hours and minutes", () => {
    expect(formatMetricValue("sleep_total_min", 432)).toBe("7h 12m");
    expect(formatMetricValue("sleep_total_min", 45)).toBe("45m");
    expect(formatMetricValue("sleep_total_min", 119.7)).toBe("2h 0m");
  });

  it("groups steps with a thousands separator and no unit", () => {
    expect(formatMetricValue("steps", 8432)).toBe("8,432");
  });

  it("appends the canonical unit for other metrics", () => {
    expect(formatMetricValue("resting_hr", 58)).toBe("58 bpm");
    expect(formatMetricValue("hrv_ms", 41.234)).toBe("41.23 ms");
    expect(formatMetricValue("weight_kg", 80.5)).toBe("80.5 kg");
  });
});

describe("buildStatCards", () => {
  it("builds one card per key vital plus the labs ratio", () => {
    const cards = buildStatCards(
      [metric("steps", 8432), metric("sleep_total_min", 432)],
      { measured: 40, inRange: 34, outOfRange: 4, unknown: 2 },
    );
    expect(cards.map((card) => card.key)).toEqual([
      "steps",
      "resting_hr",
      "hrv_ms",
      "sleep_total_min",
      "weight_kg",
      "labs-in-range",
    ]);
    expect(cards[0]).toMatchObject({
      label: "Steps",
      value: "8,432",
      sub: "on 2026-07-15",
      href: "/vitals",
    });
    expect(cards[3]).toMatchObject({ label: "Sleep", value: "7h 12m" });
    expect(cards[1]).toMatchObject({ value: "—", sub: "no data yet" });
    expect(cards[5]).toMatchObject({
      label: "Labs in range",
      value: "34 / 38",
      sub: "4 out of range",
      href: "/labs",
    });
  });

  it("reads 'all in range' when nothing is out", () => {
    const cards = buildStatCards([], {
      measured: 10,
      inRange: 10,
      outOfRange: 0,
      unknown: 0,
    });
    expect(cards[5]).toMatchObject({ value: "10 / 10", sub: "all in range" });
  });

  it("shows an em dash labs card when nothing is judgeable yet", () => {
    const cards = buildStatCards([], NO_LABS);
    expect(cards[5]).toMatchObject({ value: "—", sub: "no lab results yet" });
  });
});
