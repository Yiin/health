import { db } from "@/db";
import {
  listAllResults,
  listBiomarkersWithLatest,
} from "@/db/repos/biomarker-results";
import {
  displayFlag,
  effectiveResult,
  effectiveValueCanonical,
} from "@/lib/labs";

/**
 * Labs grid payload: the full biomarker catalog, each entry with its latest
 * result (effective values — manual overrides win) and the ascending
 * canonical-value trend that feeds the cell sparkline.
 *
 *   GET /api/labs
 *
 * Auth is enforced by the proxy matcher (same as the other /api routes).
 */
export async function GET() {
  const [withLatest, results] = await Promise.all([
    listBiomarkersWithLatest(db),
    listAllResults(db),
  ]);

  const trendByBiomarkerId = new Map<
    string,
    {
      date: string;
      value: number | null;
      refLow: number | null;
      refHigh: number | null;
    }[]
  >();
  const biomarkerById = new Map(
    withLatest.map(({ biomarker }) => [biomarker.id, biomarker]),
  );
  for (const result of results) {
    const biomarker = biomarkerById.get(result.biomarkerId);
    if (!biomarker) continue;
    const points = trendByBiomarkerId.get(result.biomarkerId) ?? [];
    points.push({
      date: result.measuredOn,
      value: effectiveValueCanonical(result, biomarker),
      refLow: result.refLow,
      refHigh: result.refHigh,
    });
    trendByBiomarkerId.set(result.biomarkerId, points);
  }

  return Response.json({
    biomarkers: withLatest.map(({ biomarker, latestResult }) => ({
      slug: biomarker.slug,
      name: biomarker.name,
      category: biomarker.category,
      canonicalUnit: biomarker.canonicalUnit,
      latest: latestResult
        ? {
            ...effectiveResult(latestResult),
            valueCanonical: effectiveValueCanonical(latestResult, biomarker),
            flag: displayFlag(latestResult, biomarker),
            refText: latestResult.refText,
            labName: latestResult.labName,
          }
        : null,
      trend: trendByBiomarkerId.get(biomarker.id) ?? [],
    })),
  });
}
