// Repository for biomarker results: insert with canonical-unit normalization
// and dedup, trend queries, and the labs-overview join. Pure functions taking
// the drizzle db handle as their first argument — no module-level state, so
// they work with both the app singleton (src/db/index.ts) and test databases.

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { convertToCanonical } from "../../lib/units";

import {
  biomarkerResults,
  biomarkers,
  type Biomarker,
  type BiomarkerResult,
  type NewBiomarkerResult,
  type ResultFlag,
} from "../schema";
import type * as schema from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

/** One as-reported lab value to persist. */
export interface NewResultInput {
  biomarkerId: string;
  /** ISO date string, YYYY-MM-DD. */
  measuredOn: string;
  /** As-reported numeric value. */
  value: number;
  /** As-reported unit string (normalized by src/lib/units.ts). */
  unit: string;
  refLow?: number | null;
  refHigh?: number | null;
  refText?: string | null;
  labName?: string | null;
  flag?: ResultFlag | null;
  documentId?: string | null;
}

export interface InsertResultsOutcome {
  inserted: number;
  skipped: number;
}

/**
 * Persists results, computing value_canonical per row from the referenced
 * biomarker's canonical unit + molar mass (null when no conversion path
 * exists — never guessed). Rows conflicting with the
 * (biomarker_id, measured_on, value_canonical) unique index are skipped, so
 * re-ingesting the same report is a no-op.
 */
export async function insertResults(
  db: Db,
  results: NewResultInput[],
): Promise<InsertResultsOutcome> {
  if (results.length === 0) return { inserted: 0, skipped: 0 };

  const biomarkerIds = [...new Set(results.map((r) => r.biomarkerId))];
  const biomarkerRows = await db
    .select()
    .from(biomarkers)
    .where(inArray(biomarkers.id, biomarkerIds));
  const biomarkerById = new Map(biomarkerRows.map((b) => [b.id, b]));

  const rows: NewBiomarkerResult[] = results.map((r) => {
    const biomarker = biomarkerById.get(r.biomarkerId);
    if (!biomarker) {
      throw new Error(
        `insertResults: unknown biomarker id ${r.biomarkerId} — resolve the catalog row before inserting`,
      );
    }
    return {
      biomarkerId: r.biomarkerId,
      measuredOn: r.measuredOn,
      value: r.value,
      unit: r.unit,
      valueCanonical: convertToCanonical(r.value, r.unit, biomarker),
      refLow: r.refLow ?? null,
      refHigh: r.refHigh ?? null,
      refText: r.refText ?? null,
      labName: r.labName ?? null,
      flag: r.flag ?? null,
      documentId: r.documentId ?? null,
    };
  });

  const insertedRows = await db
    .insert(biomarkerResults)
    .values(rows)
    .onConflictDoNothing({
      target: [
        biomarkerResults.biomarkerId,
        biomarkerResults.measuredOn,
        biomarkerResults.valueCanonical,
      ],
    })
    .returning({ id: biomarkerResults.id });

  return { inserted: insertedRows.length, skipped: rows.length - insertedRows.length };
}

export interface TrendPoint {
  measuredOn: string;
  valueCanonical: number | null;
  refLow: number | null;
  refHigh: number | null;
  labName: string | null;
}

/** Ascending measured_on series for one biomarker slug (chart input). */
export async function getTrend(
  db: Db,
  slug: string,
  range: { from?: string; to?: string } = {},
): Promise<TrendPoint[]> {
  const conditions = [eq(biomarkers.slug, slug)];
  if (range.from) conditions.push(gte(biomarkerResults.measuredOn, range.from));
  if (range.to) conditions.push(lte(biomarkerResults.measuredOn, range.to));

  const rows = await db
    .select({
      measuredOn: biomarkerResults.measuredOn,
      valueCanonical: biomarkerResults.valueCanonical,
      refLow: biomarkerResults.refLow,
      refHigh: biomarkerResults.refHigh,
      labName: biomarkerResults.labName,
    })
    .from(biomarkerResults)
    .innerJoin(biomarkers, eq(biomarkerResults.biomarkerId, biomarkers.id))
    .where(and(...conditions))
    .orderBy(asc(biomarkerResults.measuredOn));

  return rows;
}

export interface BiomarkerWithLatest {
  biomarker: Biomarker;
  latestResult: BiomarkerResult | null;
}

/**
 * Every biomarker in the catalog joined with its most recent result (null
 * when never measured). Ordered by category, then name — the labs grid.
 */
export async function listBiomarkersWithLatest(
  db: Db,
): Promise<BiomarkerWithLatest[]> {
  const biomarkerRows = await db
    .select()
    .from(biomarkers)
    .orderBy(asc(biomarkers.category), asc(biomarkers.name));

  // Latest result per biomarker (Postgres DISTINCT ON).
  const latestRows = await db
    .selectDistinctOn([biomarkerResults.biomarkerId])
    .from(biomarkerResults)
    .orderBy(
      biomarkerResults.biomarkerId,
      desc(biomarkerResults.measuredOn),
    );
  const latestByBiomarkerId = new Map(
    latestRows.map((r) => [r.biomarkerId, r]),
  );

  return biomarkerRows.map((biomarker) => ({
    biomarker,
    latestResult: latestByBiomarkerId.get(biomarker.id) ?? null,
  }));
}
