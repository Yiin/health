import { describe, expect, it } from "vitest";

import {
  calloutsForFlags,
  computeFlags,
  formatFlagValue,
  latestFlags,
  type FlagDraw,
} from "./flags";

function draw(
  date: string,
  value: number | null,
  refLow: number | null = null,
  refHigh: number | null = null,
): FlagDraw {
  return { date, value, refLow, refHigh };
}

describe("formatFlagValue", () => {
  it("keeps at most 4 significant digits", () => {
    expect(formatFlagValue(5)).toBe("5");
    expect(formatFlagValue(5.5)).toBe("5.5");
    expect(formatFlagValue(0.083123456)).toBe("0.08312");
    expect(formatFlagValue(1234)).toBe("1234");
  });
});

describe("computeFlags — out_of_range", () => {
  it("flags a draw below the reference range", () => {
    expect(computeFlags([draw("2026-01-01", 3.1, 3.9, 5.5)])).toEqual([
      {
        kind: "out_of_range",
        date: "2026-01-01",
        severity: "warning",
        message: "Below reference range: 3.1 (ref 3.9–5.5)",
        shortLabel: "Low 3.1",
        value: 3.1,
      },
    ]);
  });

  it("flags a draw above the reference range", () => {
    const flags = computeFlags([draw("2026-01-01", 7.2, 3.9, 5.5)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: "out_of_range",
      severity: "warning",
      message: "Above reference range: 7.2 (ref 3.9–5.5)",
      shortLabel: "High 7.2",
    });
  });

  it("renders one-sided ranges", () => {
    expect(
      computeFlags([draw("2026-01-01", 7.2, null, 5.5)])[0].message,
    ).toBe("Above reference range: 7.2 (ref ≤ 5.5)");
    expect(
      computeFlags([draw("2026-01-01", 3.1, 3.9, null)])[0].message,
    ).toBe("Below reference range: 3.1 (ref ≥ 3.9)");
  });

  it("treats boundary values as in range", () => {
    expect(computeFlags([draw("2026-01-01", 3.9, 3.9, 5.5)])).toEqual([]);
    expect(computeFlags([draw("2026-01-01", 5.5, 3.9, 5.5)])).toEqual([]);
  });

  it("flags nothing without a reference range", () => {
    expect(computeFlags([draw("2026-01-01", 99)])).toEqual([]);
  });
});

describe("computeFlags — big_delta", () => {
  it("flags a change at the default 25% threshold", () => {
    const flags = computeFlags([
      draw("2026-01-01", 5),
      draw("2026-02-01", 6.25),
    ]);
    expect(flags).toEqual([
      {
        kind: "big_delta",
        date: "2026-02-01",
        severity: "warning",
        message: "+25% vs previous draw (5 → 6.25)",
        shortLabel: "+25%",
        value: 6.25,
      },
    ]);
  });

  it("flags drops with a negative percent", () => {
    const flags = computeFlags([
      draw("2026-01-01", 10),
      draw("2026-02-01", 7),
    ]);
    expect(flags[0]).toMatchObject({
      kind: "big_delta",
      message: "-30% vs previous draw (10 → 7)",
      shortLabel: "-30%",
    });
  });

  it("stays quiet just under the threshold", () => {
    expect(
      computeFlags([draw("2026-01-01", 5), draw("2026-02-01", 6.24)]),
    ).toEqual([]);
  });

  it("honors a custom threshold", () => {
    const draws = [draw("2026-01-01", 5), draw("2026-02-01", 5.5)];
    expect(computeFlags(draws)).toEqual([]);
    expect(computeFlags(draws, { deltaThreshold: 0.1 })).toHaveLength(1);
  });

  it("never flags when the previous value is 0 (undefined relative change)", () => {
    expect(computeFlags([draw("2026-01-01", 0), draw("2026-02-01", 5)])).toEqual(
      [],
    );
  });
});

describe("computeFlags — trend_reversal", () => {
  it("flags a fall after an established 3-draw rise", () => {
    const flags = computeFlags([
      draw("2026-01-01", 5),
      draw("2026-02-01", 5.5),
      draw("2026-03-01", 6),
      draw("2026-04-01", 5),
    ]);
    expect(flags).toEqual([
      {
        kind: "trend_reversal",
        date: "2026-04-01",
        severity: "info",
        message: "Trend reversal: rising across 3 draws, now falling",
        shortLabel: "Reversal",
        value: 5,
      },
    ]);
  });

  it("flags a rise after an established fall", () => {
    const flags = computeFlags([
      draw("2026-01-01", 10),
      draw("2026-02-01", 9),
      draw("2026-03-01", 8.4),
      draw("2026-04-01", 8.8),
    ]);
    expect(flags).toEqual([
      expect.objectContaining({
        kind: "trend_reversal",
        message: "Trend reversal: falling across 3 draws, now rising",
      }),
    ]);
  });

  it("needs the trend to span 3+ draws by default (4 draws total)", () => {
    const threeDraws = [
      draw("2026-01-01", 5),
      draw("2026-02-01", 5.5),
      draw("2026-03-01", 4.6),
    ];
    expect(computeFlags(threeDraws)).toEqual([]);
    expect(
      computeFlags(threeDraws, { reversalRunMoves: 1 })[0],
    ).toMatchObject({
      kind: "trend_reversal",
      message: "Trend reversal: rising across 2 draws, now falling",
    });
  });

  it("ignores single-move zigs (no established trend)", () => {
    expect(
      computeFlags([
        draw("2026-01-01", 5),
        draw("2026-02-01", 5.9),
        draw("2026-03-01", 5.3),
        draw("2026-04-01", 4.6),
      ]),
    ).toEqual([]);
  });

  it("lets a flat move break the trend run", () => {
    expect(
      computeFlags([
        draw("2026-01-01", 5),
        draw("2026-02-01", 5.9),
        draw("2026-03-01", 5.9),
        draw("2026-04-01", 4.9),
      ]),
    ).toEqual([]);
  });

  it("never flags when the last move is flat", () => {
    expect(
      computeFlags([
        draw("2026-01-01", 5),
        draw("2026-02-01", 6),
        draw("2026-03-01", 7),
        draw("2026-04-01", 7),
      ]),
    ).toEqual([]);
  });
});

describe("computeFlags — series handling", () => {
  it("sorts draws by date before evaluating", () => {
    const sorted = computeFlags([
      draw("2026-01-01", 5),
      draw("2026-02-01", 6.25),
    ]);
    const shuffled = computeFlags([
      draw("2026-02-01", 6.25),
      draw("2026-01-01", 5),
    ]);
    expect(shuffled).toEqual(sorted);
  });

  it("skips null-valued draws", () => {
    expect(
      computeFlags([
        draw("2026-01-01", 5),
        draw("2026-01-15", null, 3.9, 5.5),
        draw("2026-02-01", 6.25),
      ]),
    ).toEqual([
      expect.objectContaining({ kind: "big_delta", date: "2026-02-01" }),
    ]);
  });

  it("handles empty and all-null series", () => {
    expect(computeFlags([])).toEqual([]);
    expect(computeFlags([draw("2026-01-01", null)])).toEqual([]);
  });

  it("emits flags in ascending date order with the reversal last", () => {
    const flags = computeFlags([
      draw("2026-01-01", 8, 3.9, 5.5),
      draw("2026-02-01", 9, 3.9, 5.5),
      draw("2026-03-01", 10, 3.9, 5.5),
      draw("2026-04-01", 4, 3.9, 5.5),
    ]);
    expect(flags.map((flag) => flag.kind)).toEqual([
      "out_of_range",
      "out_of_range",
      "out_of_range",
      "big_delta",
      "trend_reversal",
    ]);
  });
});

describe("latestFlags", () => {
  it("keeps only flags attached to the latest draw", () => {
    const draws = [
      draw("2026-01-01", 7, 3.9, 5.5), // mid-history high — not current
      draw("2026-02-01", 5.5, 3.9, 5.5), // back at the range edge, small move
    ];
    expect(latestFlags(draws)).toEqual([]);
  });

  it("collects every kind of flag on the latest draw", () => {
    const draws = [
      draw("2026-01-01", 6, 3.9, 5.5),
      draw("2026-02-01", 7, 3.9, 5.5),
      draw("2026-03-01", 8, 3.9, 5.5),
      draw("2026-04-01", 3, 3.9, 5.5),
    ];
    expect(latestFlags(draws).map((flag) => flag.kind)).toEqual([
      "out_of_range",
      "big_delta",
      "trend_reversal",
    ]);
  });

  it("returns [] for empty and all-null series", () => {
    expect(latestFlags([])).toEqual([]);
    expect(latestFlags([draw("2026-01-01", null, 3.9, 5.5)])).toEqual([]);
  });
});

describe("calloutsForFlags", () => {
  it("maps flags to chart callouts with compact labels", () => {
    const flags = computeFlags([
      draw("2026-01-01", 7.2, 3.9, 5.5),
      draw("2026-02-01", 5, 3.9, 5.5),
    ]);
    expect(calloutsForFlags(flags)).toEqual([
      { date: "2026-01-01", label: "High 7.2", severity: "warning" },
      { date: "2026-02-01", label: "-31%", severity: "warning" },
    ]);
  });
});
