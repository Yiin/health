import { describe, expect, it } from "vitest";

import type { FlaggedBiomarker } from "./attention";
import { flattenFlags, resolveSourceRef } from "./insights";

describe("resolveSourceRef", () => {
  it("links documents to their detail page, labeled by the filename note", () => {
    expect(
      resolveSourceRef({ kind: "document", id: "abc", note: "labs.pdf" }),
    ).toEqual({ href: "/documents/abc", label: "labs.pdf" });
    expect(resolveSourceRef({ kind: "document", id: "abc" })).toEqual({
      href: "/documents/abc",
      label: "Source document",
    });
  });

  it("links biomarkers to their trend page", () => {
    expect(
      resolveSourceRef({ kind: "biomarker", id: "glucose", note: "Glucose" }),
    ).toEqual({ href: "/labs/glucose", label: "Glucose" });
    expect(resolveSourceRef({ kind: "biomarker", id: "glucose" })).toEqual({
      href: "/labs/glucose",
      label: "glucose",
    });
  });

  it("routes biomarker results through their biomarker slug note", () => {
    expect(
      resolveSourceRef({
        kind: "biomarker_result",
        id: "result-uuid",
        note: "ferritin",
      }),
    ).toEqual({ href: "/labs/ferritin", label: "ferritin" });
    expect(
      resolveSourceRef({ kind: "biomarker_result", id: "result-uuid" }),
    ).toBeNull();
  });

  it("drops unknown kinds", () => {
    expect(resolveSourceRef({ kind: "wearable", id: "x" })).toBeNull();
  });
});

describe("flattenFlags", () => {
  it("expands per-biomarker flags into stable card order", () => {
    const flagged: FlaggedBiomarker[] = [
      {
        slug: "glucose",
        name: "Glucose",
        canonicalUnit: "mmol/L",
        flags: [
          {
            kind: "out_of_range",
            date: "2026-02-01",
            severity: "warning",
            message: "Above reference range: 7.2 (ref 3.9–5.5)",
            shortLabel: "High 7.2",
            value: 7.2,
          },
          {
            kind: "big_delta",
            date: "2026-02-01",
            severity: "warning",
            message: "+44% vs previous draw (5 → 7.2)",
            shortLabel: "+44%",
            value: 7.2,
          },
        ],
      },
      {
        slug: "ferritin",
        name: "Ferritin",
        canonicalUnit: "ug/L",
        flags: [
          {
            kind: "trend_reversal",
            date: "2026-02-01",
            severity: "info",
            message: "Trend reversal: rising across 3 draws, now falling",
            shortLabel: "Reversal",
            value: 30,
          },
        ],
      },
    ];

    const cards = flattenFlags(flagged);
    expect(cards.map((card) => [card.slug, card.flag.kind])).toEqual([
      ["glucose", "out_of_range"],
      ["glucose", "big_delta"],
      ["ferritin", "trend_reversal"],
    ]);
    expect(cards[0]).toMatchObject({ name: "Glucose" });
  });

  it("returns an empty array when nothing is flagged", () => {
    expect(flattenFlags([])).toEqual([]);
  });
});
