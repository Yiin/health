import { db } from "@/db";
import {
  getBiomarkerBySlug,
  getResultById,
  updateResultOverrides,
} from "@/db/repos/biomarker-results";
import {
  displayFlag,
  effectiveResult,
  effectiveValueCanonical,
  parseResultPatch,
} from "@/lib/labs";

// Inline-editable lab result values. Writes go to user_overrides (never to
// the pipeline-extracted columns), so edits survive re-ingestion of the
// source document. The response carries the effective values with the
// reference-range flag recomputed, so the UI can repaint the row in place.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ biomarker: string; id: string }> },
) {
  const { biomarker: slug, id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseResultPatch(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const biomarker = await getBiomarkerBySlug(db, slug);
  if (!biomarker) {
    return Response.json({ error: "Biomarker not found" }, { status: 404 });
  }
  const existing = await getResultById(db, id);
  if (!existing || existing.biomarkerId !== biomarker.id) {
    return Response.json({ error: "Result not found" }, { status: 404 });
  }

  const updated = await updateResultOverrides(db, id, parsed.overrides);
  if (!updated) {
    return Response.json({ error: "Result not found" }, { status: 404 });
  }

  return Response.json({
    result: {
      id: updated.id,
      ...effectiveResult(updated),
      valueCanonical: effectiveValueCanonical(updated, biomarker),
      flag: displayFlag(updated, biomarker),
      refLow: updated.refLow,
      refHigh: updated.refHigh,
      refText: updated.refText,
      labName: updated.labName,
    },
  });
}
