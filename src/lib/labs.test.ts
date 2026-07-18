import { describe, expect, it } from "vitest";

import { BIOMARKER_CATEGORIES } from "../db/seed/biomarkers";
import {
  CATEGORY_ORDER,
  computeFlag,
  displayFlag,
  effectiveResult,
  effectiveValueCanonical,
  parseResultPatch,
} from "./labs";

const GLUCOSE = { canonicalUnit: "mmol/L", molarMassGMol: 180.156 };

const row = (overrides: Record<string, unknown> = {}) => ({
  measuredOn: "2026-01-10",
  value: 100,
  unit: "mg/dL",
  valueCanonical: 5.5507,
  refLow: null,
  refHigh: null,
  flag: null,
  userOverrides: null,
  ...overrides,
});

describe("effectiveResult", () => {
  it("returns the extracted values when no overrides exist", () => {
    expect(effectiveResult(row())).toEqual({
      measuredOn: "2026-01-10",
      value: 100,
      unit: "mg/dL",
      edited: false,
    });
  });

  it("applies overrides over extracted values and marks the row edited", () => {
    expect(
      effectiveResult(row({ userOverrides: { value: 5.6, unit: "mmol/L" } })),
    ).toEqual({
      measuredOn: "2026-01-10",
      value: 5.6,
      unit: "mmol/L",
      edited: true,
    });
  });
});

describe("effectiveValueCanonical", () => {
  it("reuses the stored canonical value when the as-reported pair is unedited", () => {
    expect(effectiveValueCanonical(row(), GLUCOSE)).toBe(5.5507);
  });

  it("recomputes when the value was overridden", () => {
    const canonical = effectiveValueCanonical(
      row({ userOverrides: { value: 110 } }),
      GLUCOSE,
    );
    expect(canonical).toBeCloseTo(6.106, 2);
  });

  it("recomputes when the unit was overridden", () => {
    const canonical = effectiveValueCanonical(
      row({ userOverrides: { value: 5.6, unit: "mmol/L" } }),
      GLUCOSE,
    );
    expect(canonical).toBe(5.6);
  });

  it("returns null instead of guessing an unconvertible override unit", () => {
    expect(
      effectiveValueCanonical(
        row({ userOverrides: { unit: "banana" } }),
        GLUCOSE,
      ),
    ).toBeNull();
  });
});

describe("computeFlag", () => {
  it("classifies against the reference range", () => {
    expect(computeFlag(3.5, 3.9, 5.5)).toBe("low");
    expect(computeFlag(4.5, 3.9, 5.5)).toBe("normal");
    expect(computeFlag(6.1, 3.9, 5.5)).toBe("high");
  });

  it("treats boundary values as in range", () => {
    expect(computeFlag(3.9, 3.9, 5.5)).toBe("normal");
    expect(computeFlag(5.5, 3.9, 5.5)).toBe("normal");
  });

  it("handles one-sided ranges", () => {
    expect(computeFlag(6, null, 5.5)).toBe("high");
    expect(computeFlag(5, null, 5.5)).toBe("normal");
    expect(computeFlag(3, 3.9, null)).toBe("low");
  });

  it("returns null when the value or the whole range is unknown", () => {
    expect(computeFlag(null, 3.9, 5.5)).toBeNull();
    expect(computeFlag(5, null, null)).toBeNull();
  });
});

describe("displayFlag", () => {
  it("recomputes from the effective value, so edits move the status", () => {
    const edited = row({
      flag: "high",
      refLow: 3.9,
      refHigh: 5.5,
      userOverrides: { value: 90 },
    });
    expect(displayFlag(edited, GLUCOSE)).toBe("normal");
  });

  it("falls back to the extracted flag when no range exists", () => {
    expect(displayFlag(row({ flag: "high" }), GLUCOSE)).toBe("high");
  });
});

describe("parseResultPatch", () => {
  it("accepts a full edit", () => {
    expect(
      parseResultPatch({
        value: 5.6,
        measuredOn: "2026-02-01",
        unit: "mmol/L",
      }),
    ).toEqual({
      ok: true,
      overrides: { value: 5.6, measuredOn: "2026-02-01", unit: "mmol/L" },
    });
  });

  it("accepts a single-field edit", () => {
    expect(parseResultPatch({ value: 0 })).toEqual({
      ok: true,
      overrides: { value: 0 },
    });
  });

  it("rejects non-object bodies and empty patches", () => {
    expect(parseResultPatch(null).ok).toBe(false);
    expect(parseResultPatch([1]).ok).toBe(false);
    expect(parseResultPatch({}).ok).toBe(false);
    expect(parseResultPatch({ unknown: 1 }).ok).toBe(false);
  });

  it("rejects invalid field values", () => {
    expect(parseResultPatch({ value: "high" }).ok).toBe(false);
    expect(parseResultPatch({ value: Number.NaN }).ok).toBe(false);
    expect(parseResultPatch({ measuredOn: "2026-02-30" }).ok).toBe(false);
    expect(parseResultPatch({ measuredOn: "yesterday" }).ok).toBe(false);
    expect(parseResultPatch({ unit: "" }).ok).toBe(false);
    expect(parseResultPatch({ unit: "x".repeat(51) }).ok).toBe(false);
  });
});

describe("category labels", () => {
  it("stay in sync with the seed catalog categories", () => {
    expect([...CATEGORY_ORDER].sort()).toEqual(
      [...BIOMARKER_CATEGORIES].sort(),
    );
  });
});
