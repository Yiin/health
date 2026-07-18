// User-facing biomarker result values: pipeline-extracted values with manual
// overrides applied on top (the raw extraction columns are never mutated),
// reference-range flag computation, and validation for the result PATCH
// endpoint.

import { type BiomarkerResultOverrides, type ResultFlag } from "../db/schema";
import { convertToCanonical, type BiomarkerUnitContext } from "./units";

export interface EffectiveResult {
  measuredOn: string;
  value: number;
  unit: string;
  /** True once the user has saved any manual edit. */
  edited: boolean;
}

interface ResultRow {
  measuredOn: string;
  value: number;
  unit: string;
  userOverrides: BiomarkerResultOverrides | null;
}

/**
 * Effective display values: overrides win over pipeline-extracted columns.
 * Overrides carry full values only (no null-clears — a result must always
 * have a value, date, and unit); only an absent key falls back.
 */
export function effectiveResult(row: ResultRow): EffectiveResult {
  const overrides = row.userOverrides;
  return {
    measuredOn: overrides?.measuredOn ?? row.measuredOn,
    value: overrides?.value ?? row.value,
    unit: overrides?.unit ?? row.unit,
    edited: overrides != null,
  };
}

/**
 * The effective value expressed in the biomarker's canonical unit. Reuses the
 * stored value_canonical when the as-reported pair was not edited; recomputes
 * (null when no conversion path exists — never guessed) when it was.
 */
export function effectiveValueCanonical(
  row: ResultRow & { valueCanonical: number | null },
  biomarker: BiomarkerUnitContext,
): number | null {
  const overrides = row.userOverrides;
  if (overrides?.value === undefined && overrides?.unit === undefined) {
    return row.valueCanonical;
  }
  const effective = effectiveResult(row);
  return convertToCanonical(effective.value, effective.unit, biomarker);
}

/**
 * Status vs the reference range, from a canonical value. Null when the value
 * is unknown or no bound exists — never guessed. A boundary value counts as
 * in range.
 */
export function computeFlag(
  valueCanonical: number | null,
  refLow: number | null,
  refHigh: number | null,
): ResultFlag | null {
  if (valueCanonical == null) return null;
  if (refLow == null && refHigh == null) return null;
  if (refLow != null && valueCanonical < refLow) return "low";
  if (refHigh != null && valueCanonical > refHigh) return "high";
  return "normal";
}

/**
 * Display status for a result row: recomputed from the effective canonical
 * value vs the reference range, falling back to the pipeline-extracted flag
 * when the range or conversion is missing.
 */
export function displayFlag(
  row: ResultRow & {
    valueCanonical: number | null;
    refLow: number | null;
    refHigh: number | null;
    flag: ResultFlag | null;
  },
  biomarker: BiomarkerUnitContext,
): ResultFlag | null {
  return (
    computeFlag(
      effectiveValueCanonical(row, biomarker),
      row.refLow,
      row.refHigh,
    ) ?? row.flag
  );
}

// Display names + ordering for the labs grid, keyed by the catalog's
// category strings (source of truth: BIOMARKER_CATEGORIES in
// src/db/seed/biomarkers.ts — a test asserts they stay in sync; the seed
// module itself pulls in the UCUM library, so client bundles use this map).
export const CATEGORY_LABELS: Record<string, string> = {
  cbc: "CBC",
  metabolic: "Metabolic",
  lipids: "Lipids",
  thyroid: "Thyroid",
  vitamins: "Vitamins",
  minerals: "Minerals",
  inflammation: "Inflammation",
  hormones: "Hormones",
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

const MAX_UNIT_LENGTH = 50;
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

export type ResultPatchResult =
  | { ok: true; overrides: BiomarkerResultOverrides }
  | { ok: false; error: string };

/**
 * Validates a PATCH /api/labs/[biomarker]/results/[id] body. Unknown keys are
 * ignored; at least one recognized key must be present. Overrides hold full
 * replacement values (no null-clears).
 */
export function parseResultPatch(body: unknown): ResultPatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const overrides: BiomarkerResultOverrides = {};

  if ("value" in input) {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      return { ok: false, error: "value must be a finite number" };
    }
    overrides.value = input.value;
  }

  if ("measuredOn" in input) {
    if (
      typeof input.measuredOn !== "string" ||
      !isValidDateString(input.measuredOn)
    ) {
      return { ok: false, error: "measuredOn must be a YYYY-MM-DD date" };
    }
    overrides.measuredOn = input.measuredOn;
  }

  if ("unit" in input) {
    if (typeof input.unit !== "string" || input.unit.trim().length === 0) {
      return { ok: false, error: "unit must be a non-empty string" };
    }
    const unit = input.unit.trim();
    if (unit.length > MAX_UNIT_LENGTH) {
      return {
        ok: false,
        error: `unit must be at most ${MAX_UNIT_LENGTH} characters`,
      };
    }
    overrides.unit = unit;
  }

  if (Object.keys(overrides).length === 0) {
    return {
      ok: false,
      error: "Provide at least one of: value, measuredOn, unit",
    };
  }
  return { ok: true, overrides };
}
