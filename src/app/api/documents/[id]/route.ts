import { db } from "@/db";
import { updateMetadataOverrides } from "@/db/repos/documents";
import { effectiveMetadata, parseMetadataPatch } from "@/lib/document-metadata";

// Inline-editable document metadata. Writes go to metadata_overrides (never
// to the pipeline-extracted columns), so edits survive pipeline re-runs.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseMetadataPatch(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const updated = await updateMetadataOverrides(db, id, parsed.overrides);
  if (!updated) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  return Response.json({ metadata: effectiveMetadata(updated) });
}
