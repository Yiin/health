// User-facing document metadata: pipeline-extracted values with manual
// overrides applied on top, plus validation for the metadata PATCH endpoint.

import {
  DOCUMENT_TYPES,
  type DocumentMetadataOverrides,
  type DocumentType,
} from "../db/schema";

export interface EffectiveMetadata {
  documentType: DocumentType;
  provider: string | null;
  documentDate: string | null;
  /** True once the user has saved any manual edit. */
  edited: boolean;
}

interface MetadataRow {
  documentType: DocumentType;
  provider: string | null;
  documentDate: string | null;
  metadataOverrides: DocumentMetadataOverrides | null;
}

/**
 * Effective display metadata: overrides win over pipeline-extracted columns.
 * An override key explicitly set to null means "cleared by the user" and also
 * wins; only an absent key falls back to the extracted value.
 */
export function effectiveMetadata(row: MetadataRow): EffectiveMetadata {
  const overrides = row.metadataOverrides;
  return {
    documentType: overrides?.documentType ?? row.documentType,
    provider:
      overrides && "provider" in overrides
        ? (overrides.provider ?? null)
        : row.provider,
    documentDate:
      overrides && "documentDate" in overrides
        ? (overrides.documentDate ?? null)
        : row.documentDate,
    edited: overrides != null,
  };
}

const MAX_PROVIDER_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-trip: V8 rolls out-of-range days over ("2026-02-30" → Mar 2)
  // instead of returning NaN, so compare against the input.
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export type MetadataPatchResult =
  | { ok: true; overrides: DocumentMetadataOverrides }
  | { ok: false; error: string };

/**
 * Validates a PATCH /api/documents/[id] body. Unknown keys are ignored; at
 * least one recognized key must be present. Empty-string provider/date mean
 * "cleared" (stored as null).
 */
export function parseMetadataPatch(body: unknown): MetadataPatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const overrides: DocumentMetadataOverrides = {};

  if ("documentType" in input) {
    if (
      typeof input.documentType !== "string" ||
      !(DOCUMENT_TYPES as readonly string[]).includes(input.documentType)
    ) {
      return {
        ok: false,
        error: `documentType must be one of: ${DOCUMENT_TYPES.join(", ")}`,
      };
    }
    overrides.documentType = input.documentType as DocumentType;
  }

  if ("provider" in input) {
    if (input.provider === null || input.provider === "") {
      overrides.provider = null;
    } else if (typeof input.provider === "string") {
      const provider = input.provider.trim();
      if (provider.length === 0) {
        overrides.provider = null;
      } else if (provider.length > MAX_PROVIDER_LENGTH) {
        return {
          ok: false,
          error: `provider must be at most ${MAX_PROVIDER_LENGTH} characters`,
        };
      } else {
        overrides.provider = provider;
      }
    } else {
      return { ok: false, error: "provider must be a string or null" };
    }
  }

  if ("documentDate" in input) {
    if (input.documentDate === null || input.documentDate === "") {
      overrides.documentDate = null;
    } else if (typeof input.documentDate === "string") {
      if (!isValidDateString(input.documentDate)) {
        return {
          ok: false,
          error: "documentDate must be YYYY-MM-DD or null",
        };
      }
      overrides.documentDate = input.documentDate;
    } else {
      return { ok: false, error: "documentDate must be a string or null" };
    }
  }

  if (Object.keys(overrides).length === 0) {
    return {
      ok: false,
      error: "Provide at least one of: documentType, provider, documentDate",
    };
  }
  return { ok: true, overrides };
}
