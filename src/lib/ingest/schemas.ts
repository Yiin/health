// Zod schemas + chatStructured JSON Schemas for the lab-report ingestion
// stages (worker/extract.ts, worker/normalize.ts).
//
// Three schema families live here:
//   1. LAB_EXTRACTION — the model's per-document output: collection date, lab
//      name, and every measured analyte as reported (name/value/unit +
//      optional reference range and flag).
//   2. BIOMARKER_MAPPING — the normalization fallback that maps as-reported
//      analyte names onto biomarkers catalog slugs.
//   3. MEDICAL_DOC_EXTRACTION — the vision path's output for non-lab medical
//      documents: provider, document date, English summary, key findings.
//
// The zod schema is the validator (callers own retry/escalation, mirroring
// the classifier in worker/classify.ts). The JSON Schema is hand-written next
// to it — kept in sync by the tests in src/lib/ingest/schemas.test.ts — and
// follows the strict structured-output convention: every property is listed
// in `required`, optional fields are `anyOf [type, null]` (the zod side uses
// .nullish() to accept both missing and explicit null).
//
// This module must stay importable from the worker under plain node type
// stripping: the only relative import is type-only (erased at load).

import { z } from "zod";

import { RESULT_FLAGS } from "../../db/schema.ts";

/** ISO 8601 date (YYYY-MM-DD) or datetime — the sample collection moment. */
const ISO_DATE_OR_DATETIME =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const extractedBiomarkerSchema = z.object({
  /** Analyte name exactly as printed (kept in the report's language). */
  name: z.string().min(1),
  /** Numeric value as a JSON number (decimal commas converted by the model). */
  value: z.number().finite(),
  /** Unit exactly as printed ("mmol/l", "10^9/L", "mTV/L", ...). */
  unit: z.string().min(1),
  referenceLow: z.number().finite().nullish(),
  referenceHigh: z.number().finite().nullish(),
  /** Raw range string when it is not a plain low-high interval ("< 5.2"). */
  referenceText: z.string().nullish(),
  flag: z.enum(RESULT_FLAGS).nullish(),
});
export type ExtractedBiomarker = z.infer<typeof extractedBiomarkerSchema>;

export const labExtractionSchema = z.object({
  measuredAt: z
    .string()
    .regex(
      ISO_DATE_OR_DATETIME,
      "expected an ISO 8601 date (YYYY-MM-DD) or datetime",
    ),
  /** Laboratory/provider name as printed; empty string when absent. */
  labName: z.string(),
  biomarkers: z.array(extractedBiomarkerSchema),
});
export type LabExtraction = z.infer<typeof labExtractionSchema>;

/** The date a result was measured on (date part of measuredAt). */
export function measuredOnOf(extraction: LabExtraction): string {
  return extraction.measuredAt.slice(0, 10);
}

export const LAB_EXTRACTION_JSON_SCHEMA = {
  name: "lab_extraction",
  description:
    "All biomarker results from one laboratory report (English or Lithuanian).",
  strict: true,
  schema: {
    type: "object",
    properties: {
      measuredAt: {
        type: "string",
        description:
          "Sample collection moment as ISO 8601 date (YYYY-MM-DD) or datetime; the specimen date, not the print date.",
      },
      labName: {
        type: "string",
        description:
          "Laboratory/provider name as printed; empty string when absent.",
      },
      biomarkers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Analyte name exactly as printed, in the report's language.",
            },
            value: {
              type: "number",
              description:
                "Numeric result (convert decimal commas: 5,4 becomes 5.4).",
            },
            unit: { type: "string", description: "Unit exactly as printed." },
            referenceLow: {
              anyOf: [{ type: "number" }, { type: "null" }],
              description: "Lower reference bound, when printed as a number.",
            },
            referenceHigh: {
              anyOf: [{ type: "number" }, { type: "null" }],
              description: "Upper reference bound, when printed as a number.",
            },
            referenceText: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description:
                "Raw reference string when it is not a plain low-high interval ('< 5.2', 'negative').",
            },
            flag: {
              anyOf: [
                { type: "string", enum: [...RESULT_FLAGS] },
                { type: "null" },
              ],
              description:
                "The report's own abnormality marker (H/high, L/low, N/normal), null when absent.",
            },
          },
          required: [
            "name",
            "value",
            "unit",
            "referenceLow",
            "referenceHigh",
            "referenceText",
            "flag",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["measuredAt", "labName", "biomarkers"],
    additionalProperties: false,
  },
} as const;

/**
 * MEDICAL_DOC_EXTRACTION — the vision path's per-document output for non-lab
 * medical documents (discharge letters, referrals, imaging reports,
 * prescriptions, doctor's notes): provider, document date, an English
 * summary, and the key findings. Used by worker/extract.ts for medical_doc
 * images and scanned medical PDFs; there is no text-layer variant yet.
 */
export const medicalDocExtractionSchema = z.object({
  /** Clinic/hospital/doctor name as printed; empty string when absent. */
  provider: z.string(),
  /** The document's own date (YYYY-MM-DD or datetime), null when absent. */
  documentDate: z
    .string()
    .regex(
      ISO_DATE_OR_DATETIME,
      "expected an ISO 8601 date (YYYY-MM-DD) or datetime",
    )
    .nullish(),
  /** 2-3 sentence English summary for the documents library. */
  summary: z.string().min(1),
  /** Clinically important points, one per entry, in English. */
  keyFindings: z.array(z.string().min(1)),
});
export type MedicalDocExtraction = z.infer<typeof medicalDocExtractionSchema>;

export const MEDICAL_DOC_EXTRACTION_JSON_SCHEMA = {
  name: "medical_doc_extraction",
  description:
    "Metadata + summary of one non-lab medical document (English or Lithuanian), read from page images.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description:
          "Clinic/hospital/doctor name as printed; empty string when absent.",
      },
      documentDate: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "The document's own date as ISO 8601 (YYYY-MM-DD); null when not identifiable.",
      },
      summary: {
        type: "string",
        description:
          "2-3 sentence English summary of the document for the library.",
      },
      keyFindings: {
        type: "array",
        items: {
          type: "string",
          description:
            "One clinically important point (diagnosis, recommendation, medication), in English.",
        },
      },
    },
    required: ["provider", "documentDate", "summary", "keyFindings"],
    additionalProperties: false,
  },
} as const;

export const biomarkerMappingSchema = z.object({
  mappings: z.array(
    z.object({
      /** An as-reported analyte name from the request, verbatim. */
      name: z.string().min(1),
      /** Catalog slug it corresponds to, or null when nothing fits. */
      slug: z.string().min(1).nullable(),
    }),
  ),
});
export type BiomarkerMapping = z.infer<typeof biomarkerMappingSchema>;

export const BIOMARKER_MAPPING_JSON_SCHEMA = {
  name: "biomarker_mapping",
  description:
    "Maps as-reported lab analyte names onto a fixed biomarker catalog.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "An as-reported analyte name from the request, verbatim.",
            },
            slug: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description:
                "The catalog slug this name corresponds to, or null when no catalog entry fits.",
            },
          },
          required: ["name", "slug"],
          additionalProperties: false,
        },
      },
    },
    required: ["mappings"],
    additionalProperties: false,
  },
} as const;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** JSON.parse + zod validation, with a compact issue list for retry prompts. */
function parseWith<T>(
  raw: string,
  schema: { safeParse: (data: unknown) => z.ZodSafeParseResult<T> },
): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `schema mismatch: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/** Validates the raw chatStructured JSON string for LAB_EXTRACTION. */
export function parseLabExtraction(raw: string): ParseResult<LabExtraction> {
  return parseWith(raw, labExtractionSchema);
}

/** Validates the raw chatStructured JSON string for BIOMARKER_MAPPING. */
export function parseBiomarkerMapping(
  raw: string,
): ParseResult<BiomarkerMapping> {
  return parseWith(raw, biomarkerMappingSchema);
}

/** Validates the raw chatStructured JSON string for MEDICAL_DOC_EXTRACTION. */
export function parseMedicalDocExtraction(
  raw: string,
): ParseResult<MedicalDocExtraction> {
  return parseWith(raw, medicalDocExtractionSchema);
}
