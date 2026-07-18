import { describe, expect, it } from "vitest";

import { BIOMARKER_SEED } from "../../db/seed/biomarkers";

import {
  levenshtein,
  matchBiomarker,
  normalizeAnalyteName,
  type CatalogEntry,
} from "./mapping";

// Catalog entries in the shape matching needs, straight from the seed.
const CATALOG: CatalogEntry[] = BIOMARKER_SEED.map((b, i) => ({
  id: `id-${i}`,
  slug: b.slug,
  name: b.name,
  aliases: b.aliases,
}));

function match(name: string) {
  return matchBiomarker(name, CATALOG);
}

describe("normalizeAnalyteName", () => {
  it("folds case, diacritics, and punctuation", () => {
    expect(normalizeAnalyteName("  Gliukozė (Kraujyje) ")).toBe(
      "gliukoze kraujyje",
    );
    expect(normalizeAnalyteName("Vitamin D (25-OH)")).toBe("vitamin d 25 oh");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("ttg", "tth")).toBe(1);
    expect(levenshtein("carbamide", "karbamidas")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
  });
});

describe("matchBiomarker — exact", () => {
  it.each([
    ["Hemoglobin", "hemoglobin"],
    ["hemoglobin", "hemoglobin"],
    ["HEMOGLOBINAS", "hemoglobin"],
    ["wbc", "wbc"],
    ["White blood cells", "wbc"],
    ["Leukocitai", "wbc"],
    ["Gliukozė", "glucose"],
    ["Vitamin D (25-OH)", "vitamin-d-25oh"], // the catalog display name
  ])("%s → %s", (input, expected) => {
    const result = match(input);
    expect(result?.entry.slug).toBe(expected);
    expect(result?.via).toBe("exact");
  });

  it("TTG has no exact match (it is a fuzzy hit, not an alias)", () => {
    expect(match("TTG")?.via).not.toBe("exact");
  });
});

describe("matchBiomarker — fuzzy", () => {
  it("matches the Lithuanian TSH abbreviation TTG via alias 'tth'", () => {
    const result = match("TTG");
    expect(result?.entry.slug).toBe("tsh");
    expect(result?.via).toBe("fuzzy");
  });

  it("does not bridge TTG → 'trig' (triglycerides) via an insertion", () => {
    expect(match("TTG")?.entry.slug).not.toBe("triglycerides");
  });

  it("matches a longer name containing an alias", () => {
    const result = match("Vitamin D 25-hydroxy");
    expect(result?.entry.slug).toBe("vitamin-d-25oh");
    expect(result?.via).toBe("fuzzy");
  });

  it("matches a one-edit typo", () => {
    const result = match("hemoglobiin");
    expect(result?.entry.slug).toBe("hemoglobin");
  });

  it("does not let short aliases containment-match (HDL vs LDL)", () => {
    // "ldl" is 3 chars: no containment; LDL-C must resolve to ldl only.
    expect(match("LDL-C")?.entry.slug).toBe("ldl");
    expect(match("HDL cholesterol")?.entry.slug).toBe("hdl");
  });

  it("returns null for names nothing fits (LLM fallback territory)", () => {
    expect(match("Homocysteine")).toBeNull();
    expect(match("Carbamide")).toBeNull(); // 3 edits from 'karbamidas'
  });

  it("returns null for empty input", () => {
    expect(match("   ")).toBeNull();
  });
});
