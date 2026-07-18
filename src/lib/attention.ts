// DB-facing assembly for the flag engine (src/lib/flags.ts): turns the stored
// biomarker series into per-biomarker flags for the overview "needs attention"
// strip and the /insights flag cards, and summarizes the latest in-range
// ratio for the overview stat card. Effective values win (manual overrides
// recompute the canonical value), matching what the labs pages display.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  listAllResults,
  listBiomarkersWithLatest,
} from "../db/repos/biomarker-results";
import type * as schema from "../db/schema";

import {
  latestFlags,
  type BiomarkerFlag,
  type FlagDraw,
  type FlagOptions,
} from "./flags";
import { displayFlag, effectiveValueCanonical } from "./labs";

type Db = PostgresJsDatabase<typeof schema>;

export interface FlaggedBiomarker {
  slug: string;
  name: string;
  canonicalUnit: string;
  /** Flags attached to the most recent draw (never empty here). */
  flags: BiomarkerFlag[];
}

/**
 * Biomarkers whose LATEST draw carries at least one flag, in catalog order
 * (category, then name — the same order as the labs grid).
 */
export async function listFlaggedBiomarkers(
  db: Db,
  options: FlagOptions = {},
): Promise<FlaggedBiomarker[]> {
  const [withLatest, results] = await Promise.all([
    listBiomarkersWithLatest(db),
    listAllResults(db),
  ]);

  const biomarkerById = new Map(
    withLatest.map(({ biomarker }) => [biomarker.id, biomarker]),
  );
  const drawsByBiomarkerId = new Map<string, FlagDraw[]>();
  for (const result of results) {
    const biomarker = biomarkerById.get(result.biomarkerId);
    if (!biomarker) continue;
    const draws = drawsByBiomarkerId.get(result.biomarkerId) ?? [];
    draws.push({
      date: result.measuredOn,
      value: effectiveValueCanonical(result, biomarker),
      refLow: result.refLow,
      refHigh: result.refHigh,
    });
    drawsByBiomarkerId.set(result.biomarkerId, draws);
  }

  const flagged: FlaggedBiomarker[] = [];
  for (const { biomarker } of withLatest) {
    const draws = drawsByBiomarkerId.get(biomarker.id);
    if (!draws || draws.length === 0) continue;
    const flags = latestFlags(draws, options);
    if (flags.length > 0) {
      flagged.push({
        slug: biomarker.slug,
        name: biomarker.name,
        canonicalUnit: biomarker.canonicalUnit,
        flags,
      });
    }
  }
  return flagged;
}

export interface InRangeSummary {
  /** Biomarkers with at least one result. */
  measured: number;
  /** Latest draw in range. */
  inRange: number;
  /** Latest draw out of range (low or high). */
  outOfRange: number;
  /** Measured but not judgeable (no reference range or no conversion). */
  unknown: number;
}

/** The in-range ratio behind the overview's labs stat card. */
export async function summarizeInRange(db: Db): Promise<InRangeSummary> {
  const withLatest = await listBiomarkersWithLatest(db);
  const summary: InRangeSummary = {
    measured: 0,
    inRange: 0,
    outOfRange: 0,
    unknown: 0,
  };
  for (const { biomarker, latestResult } of withLatest) {
    if (!latestResult) continue;
    summary.measured += 1;
    const flag = displayFlag(latestResult, biomarker);
    if (flag === "normal") summary.inRange += 1;
    else if (flag === "low" || flag === "high") summary.outOfRange += 1;
    else summary.unknown += 1;
  }
  return summary;
}
