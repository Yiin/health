import { describe, expect, it } from "vitest";

import { convertToCanonical, normalizeUnitString } from "./units";

describe("normalizeUnitString", () => {
  it("trims and strips internal spaces", () => {
    expect(normalizeUnitString("  mmol / L ")).toBe("mmol/L");
  });

  it("case-fixes common lab spellings", () => {
    expect(normalizeUnitString("mmol/l")).toBe("mmol/L");
    expect(normalizeUnitString("mg/dl")).toBe("mg/dL");
    expect(normalizeUnitString("G/L")).toBe("g/L");
  });

  it("maps 10^9/L to 10*9/L", () => {
    expect(normalizeUnitString("10^9/L")).toBe("10*9/L");
    expect(normalizeUnitString("10^9/l")).toBe("10*9/L");
  });

  it("maps µIU/mL to u[IU]/mL (both micro signs)", () => {
    expect(normalizeUnitString("µIU/mL")).toBe("u[IU]/mL");
    expect(normalizeUnitString("μIU/mL")).toBe("u[IU]/mL");
  });

  it("returns the cleaned string when no fix makes it valid UCUM", () => {
    expect(normalizeUnitString("banana unit")).toBe("bananaunit");
  });

  it("returns an empty string for garbage input", () => {
    expect(normalizeUnitString("")).toBe("");
    expect(normalizeUnitString("   ")).toBe("");
    expect(normalizeUnitString(null as unknown as string)).toBe("");
  });
});

describe("convertToCanonical", () => {
  const glucose = { canonicalUnit: "mmol/L", molarMassGMol: 180.156 };
  const cholesterol = { canonicalUnit: "mmol/L", molarMassGMol: 386.654 };
  const ferritin = { canonicalUnit: "ug/L", molarMassGMol: null };

  it("passes values through when the unit already matches", () => {
    expect(convertToCanonical(5.2, "mmol/L", glucose)).toBe(5.2);
  });

  it("normalizes the as-reported unit before comparing", () => {
    expect(convertToCanonical(5.2, " mmol / l ", glucose)).toBe(5.2);
  });

  it("converts 100 mg/dL glucose to ~5.55 mmol/L", () => {
    expect(convertToCanonical(100, "mg/dL", glucose)).toBeCloseTo(5.55, 2);
  });

  it("converts mmol/L back to mg/dL via the molar mass", () => {
    expect(
      convertToCanonical(5.5, "mmol/L", {
        canonicalUnit: "mg/dL",
        molarMassGMol: 180.156,
      }),
    ).toBeCloseTo(99.1, 1);
  });

  it("round-trips cholesterol mg/dL <-> mmol/L within 0.5%", () => {
    const canonical = convertToCanonical(200, "mg/dL", cholesterol);
    expect(canonical).not.toBeNull();
    const back = convertToCanonical(canonical!, "mmol/L", {
      canonicalUnit: "mg/dL",
      molarMassGMol: 386.654,
    });
    expect(back).not.toBeNull();
    expect(Math.abs(back! - 200) / 200).toBeLessThan(0.005);
  });

  it("converts commensurable units without a molar mass", () => {
    expect(convertToCanonical(50, "ng/mL", ferritin)).toBeCloseTo(50, 6);
    expect(
      convertToCanonical(13.5, "g/dL", {
        canonicalUnit: "g/L",
        molarMassGMol: null,
      }),
    ).toBeCloseTo(135, 6);
  });

  it("converts vitamin D ng/mL to nmol/L via the molar mass", () => {
    expect(
      convertToCanonical(30, "ng/mL", {
        canonicalUnit: "nmol/L",
        molarMassGMol: 384.64,
      }),
    ).toBeCloseTo(78.0, 1);
  });

  it("converts creatinine umol/L to mg/dL via the molar mass", () => {
    expect(
      convertToCanonical(88.4, "umol/L", {
        canonicalUnit: "mg/dL",
        molarMassGMol: 113.12,
      }),
    ).toBeCloseTo(1.0, 2);
  });

  it("converts triglycerides mg/dL to mmol/L via the molar mass", () => {
    expect(
      convertToCanonical(150, "mg/dL", {
        canonicalUnit: "mmol/L",
        molarMassGMol: 885.7,
      }),
    ).toBeCloseTo(1.69, 2);
  });

  it("returns null for incommensurable units without a molar mass", () => {
    expect(convertToCanonical(14, "g/dL", { canonicalUnit: "%" })).toBeNull();
  });

  it("returns null for mol<->mass when the biomarker has no molar mass", () => {
    expect(
      convertToCanonical(100, "mg/dL", {
        canonicalUnit: "mmol/L",
        molarMassGMol: null,
      }),
    ).toBeNull();
  });

  it("returns null for a non-positive molar mass", () => {
    expect(
      convertToCanonical(100, "mg/dL", {
        canonicalUnit: "mmol/L",
        molarMassGMol: 0,
      }),
    ).toBeNull();
  });

  it("returns null for unrecognized units", () => {
    expect(convertToCanonical(1, "banana", glucose)).toBeNull();
    expect(
      convertToCanonical(1, "mg/dL", {
        canonicalUnit: "banana",
        molarMassGMol: 1,
      }),
    ).toBeNull();
  });

  it("returns null for non-finite values and never throws on garbage", () => {
    expect(convertToCanonical(Number.NaN, "mg/dL", glucose)).toBeNull();
    expect(convertToCanonical(Number.POSITIVE_INFINITY, "mg/dL", glucose)).toBeNull();
    expect(
      convertToCanonical(1, null as unknown as string, glucose),
    ).toBeNull();
  });
});
