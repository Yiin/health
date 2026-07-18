import { describe, expect, it } from "vitest";

import {
  BIOMARKER_MAPPING_JSON_SCHEMA,
  DOCUMENT_SUMMARY_JSON_SCHEMA,
  LAB_EXTRACTION_JSON_SCHEMA,
  POST_INGESTION_INSIGHT_JSON_SCHEMA,
  labExtractionSchema,
  measuredOnOf,
  parseBiomarkerMapping,
  parseDocumentSummary,
  parseLabExtraction,
  parsePostIngestionInsight,
} from "./schemas";

const VALID_PAYLOAD = {
  measuredAt: "2026-03-14",
  labName: "City Central Laboratory",
  biomarkers: [
    {
      name: "Hemoglobin",
      value: 14.2,
      unit: "g/dL",
      referenceLow: 12.0,
      referenceHigh: 16.0,
      referenceText: null,
      flag: null,
    },
    { name: "Glucose", value: 95, unit: "mg/dL" },
  ],
};

const VALID_REPLY = JSON.stringify(VALID_PAYLOAD);

/** JSON string of the valid payload with one mutation applied. */
function replyWith(mutate: (payload: typeof VALID_PAYLOAD) => void): string {
  const payload = structuredClone(VALID_PAYLOAD);
  mutate(payload);
  return JSON.stringify(payload);
}

describe("parseLabExtraction", () => {
  it("accepts a valid reply with optional fields missing or null", () => {
    const parsed = parseLabExtraction(VALID_REPLY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.biomarkers).toHaveLength(2);
    expect(parsed.value.biomarkers[1].referenceLow).toBeUndefined();
  });

  it("accepts an ISO datetime for measuredAt and derives the date", () => {
    const parsed = parseLabExtraction(
      replyWith((p) => {
        p.measuredAt = "2026-03-14T08:30:00Z";
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(measuredOnOf(parsed.value)).toBe("2026-03-14");
  });

  it("rejects non-JSON input", () => {
    const parsed = parseLabExtraction("{not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^not JSON:/);
  });

  it("rejects a non-numeric value with a path-tagged issue", () => {
    const parsed = parseLabExtraction(
      replyWith((p) => {
        (p.biomarkers[0] as { value: unknown }).value = "14,2";
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/^schema mismatch:/);
      expect(parsed.error).toContain("biomarkers.0.value");
    }
  });

  it("rejects a malformed measuredAt", () => {
    const parsed = parseLabExtraction(
      replyWith((p) => {
        p.measuredAt = "14.03.2026";
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    const parsed = parseLabExtraction(
      replyWith((p) => {
        (p.biomarkers[0] as { flag: unknown }).flag = "critical";
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects an empty analyte name", () => {
    const parsed = parseLabExtraction(
      replyWith((p) => {
        p.biomarkers[0].name = "";
      }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("labExtractionSchema", () => {
  it("accepts an empty biomarkers array (page of text, no analytes)", () => {
    const parsed = labExtractionSchema.safeParse({
      measuredAt: "2026-03-14",
      labName: "",
      biomarkers: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("parseBiomarkerMapping", () => {
  it("accepts slug-or-null mappings", () => {
    const parsed = parseBiomarkerMapping(
      JSON.stringify({
        mappings: [
          { name: "Carbamide", slug: "bun" },
          { name: "Homocysteine", slug: null },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a missing slug field", () => {
    const parsed = parseBiomarkerMapping(
      JSON.stringify({ mappings: [{ name: "Carbamide" }] }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("parseDocumentSummary", () => {
  it("accepts a valid summary", () => {
    const parsed = parseDocumentSummary(
      JSON.stringify({ summary: "Blood panel from SYNLAB, 32 analytes." }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.summary).toContain("SYNLAB");
  });

  it("rejects an empty summary", () => {
    const parsed = parseDocumentSummary(JSON.stringify({ summary: "" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("summary");
  });

  it("rejects non-JSON input", () => {
    const parsed = parseDocumentSummary("{not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^not JSON:/);
  });
});

describe("parsePostIngestionInsight", () => {
  it("accepts a valid title + body", () => {
    const parsed = parsePostIngestionInsight(
      JSON.stringify({
        title: "Ferritin down 40% since October, now in range",
        body: "Ferritin fell from 120 to 72 µg/L ...",
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a missing body", () => {
    const parsed = parsePostIngestionInsight(
      JSON.stringify({ title: "Only a title" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("body");
  });
});

describe("JSON Schemas (strict structured-output convention)", () => {
  it("lists every extraction property in required", () => {
    const { properties, required } =
      LAB_EXTRACTION_JSON_SCHEMA.schema.properties.biomarkers.items;
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
    expect([...LAB_EXTRACTION_JSON_SCHEMA.schema.required].sort()).toEqual(
      Object.keys(LAB_EXTRACTION_JSON_SCHEMA.schema.properties).sort(),
    );
  });

  it("declares optional extraction fields as type-or-null", () => {
    const { properties } =
      LAB_EXTRACTION_JSON_SCHEMA.schema.properties.biomarkers.items;
    for (const key of [
      "referenceLow",
      "referenceHigh",
      "referenceText",
      "flag",
    ]) {
      const property: unknown = properties[key as keyof typeof properties];
      expect(property).toHaveProperty("anyOf");
      const anyOf = (property as { anyOf: unknown[] }).anyOf;
      expect(JSON.stringify(anyOf)).toContain('"null"');
    }
  });

  it("lists every mapping property in required", () => {
    const { properties, required } =
      BIOMARKER_MAPPING_JSON_SCHEMA.schema.properties.mappings.items;
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
  });

  it.each([
    ["summary", DOCUMENT_SUMMARY_JSON_SCHEMA.schema],
    ["insight", POST_INGESTION_INSIGHT_JSON_SCHEMA.schema],
  ] as const)("lists every %s property in required", (_name, schema) => {
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
  });
});
