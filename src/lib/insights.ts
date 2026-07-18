// Insights feed helpers: resolving ai_insights.source_refs to dashboard
// links, badge labels, and the /insights data load (deterministic flag cards
// + the AI insight feed). Source refs are written by the worker's summarizing
// stage as { kind: "document" | "biomarker" | "biomarker_result", id, note? }
// — see worker/summarize.ts and src/db/schema.ts.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { listInsights } from "../db/repos/insights";
import type { AiInsight, InsightKind, InsightSourceRef } from "../db/schema";
import type * as schema from "../db/schema";

import { listFlaggedBiomarkers, type FlaggedBiomarker } from "./attention";
import type { BiomarkerFlag } from "./flags";

type Db = PostgresJsDatabase<typeof schema>;

export const INSIGHT_KIND_LABELS: Record<InsightKind, string> = {
  post_ingestion: "Post-ingestion",
  biomarker_trend: "Trend",
  anomaly: "Anomaly",
};

export interface ResolvedSourceRef {
  href: string;
  label: string;
}

/**
 * Maps one source_ref to a dashboard link. Kinds: "document" → the document
 * detail page (note carries the filename); "biomarker" → the labs trend page
 * (id is the slug); "biomarker_result" → the owning biomarker's trend page
 * (note carries the slug; the result id alone is not routable). Unknown or
 * unroutable refs resolve to null and are dropped from the rendered list.
 */
export function resolveSourceRef(ref: InsightSourceRef): ResolvedSourceRef | null {
  if (ref.kind === "document") {
    return { href: `/documents/${ref.id}`, label: ref.note ?? "Source document" };
  }
  if (ref.kind === "biomarker") {
    return { href: `/labs/${ref.id}`, label: ref.note ?? ref.id };
  }
  if (ref.kind === "biomarker_result") {
    return ref.note ? { href: `/labs/${ref.note}`, label: ref.note } : null;
  }
  return null;
}

/** One flag card on /insights: a flagged biomarker plus one of its flags. */
export interface FlagCardData {
  slug: string;
  name: string;
  flag: BiomarkerFlag;
}

/** Flattens per-biomarker flags into individual cards (stable order). */
export function flattenFlags(flagged: FlaggedBiomarker[]): FlagCardData[] {
  return flagged.flatMap((biomarker) =>
    biomarker.flags.map((flag) => ({
      slug: biomarker.slug,
      name: biomarker.name,
      flag,
    })),
  );
}

export interface InsightsData {
  flags: FlagCardData[];
  insights: AiInsight[];
}

/** Everything /insights renders: flag cards first, then the AI feed. */
export async function loadInsightsData(
  db: Db,
  options: { limit?: number } = {},
): Promise<InsightsData> {
  const [flagged, insights] = await Promise.all([
    listFlaggedBiomarkers(db),
    listInsights(db, { limit: options.limit ?? 100 }),
  ]);
  return { flags: flattenFlags(flagged), insights };
}
