import { describe, expect, it } from "vitest";

import {
  BIOMARKER_CATEGORIES,
  BIOMARKER_SEED,
  validateBiomarkerCatalog,
} from "./biomarkers";

describe("biomarker seed catalog", () => {
  it("passes its own validation (valid UCUM units, unique slugs)", () => {
    expect(() => validateBiomarkerCatalog()).not.toThrow();
  });

  it("covers ~40 biomarkers across all categories", () => {
    expect(BIOMARKER_SEED.length).toBeGreaterThanOrEqual(35);
    for (const category of BIOMARKER_CATEGORIES) {
      expect(
        BIOMARKER_SEED.some((b) => b.category === category),
        `category ${category} is empty`,
      ).toBe(true);
    }
  });

  it("gives glucose a molar mass and >=3 aliases including Lithuanian", () => {
    const glucose = BIOMARKER_SEED.find((b) => b.slug === "glucose");
    expect(glucose).toBeDefined();
    expect(glucose!.molarMassGMol).toBeCloseTo(180.156, 3);
    expect(glucose!.aliases.length).toBeGreaterThanOrEqual(3);
    expect(glucose!.aliases).toContain("gliukozė");
  });

  it("carries the molar masses the unit conversions rely on", () => {
    const molarMassBySlug = new Map(
      BIOMARKER_SEED.map((b) => [b.slug, b.molarMassGMol]),
    );
    expect(molarMassBySlug.get("total-cholesterol")).toBeCloseTo(386.654, 3);
    expect(molarMassBySlug.get("creatinine")).toBeCloseTo(113.12, 2);
    expect(molarMassBySlug.get("bun")).toBeCloseTo(60.06, 2);
    expect(molarMassBySlug.get("calcium")).toBeCloseTo(40.078, 3);
    expect(molarMassBySlug.get("vitamin-d-25oh")).toBeCloseTo(384.64, 2);
  });

  it("includes Lithuanian spellings for the common analytes", () => {
    const ltBySlug: Record<string, string> = {
      hemoglobin: "hemoglobinas",
      creatinine: "kreatininas",
      platelets: "trombocitai",
      tsh: "tirotropinas",
      ferritin: "feritinas",
    };
    for (const [slug, alias] of Object.entries(ltBySlug)) {
      const entry = BIOMARKER_SEED.find((b) => b.slug === slug);
      expect(entry?.aliases, `${slug} aliases`).toContain(alias);
    }
  });
});
