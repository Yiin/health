import { reprocessDocument } from "@/lib/uploads";

/**
 * Re-enqueues ingestion for a `done` document, clearing its raw_extractions
 * stage cache first so every stage re-runs against the CURRENT pipeline —
 * the recovery path for documents that finished while stages were still
 * stubs (done/unknown with zero extracted data), which /retry refuses
 * because a retry deliberately resumes from the cache. 404 for unknown ids,
 * 409 for any other status (failed/needs_review belong to /retry).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const outcome = await reprocessDocument(id);

  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "unknown document" }, { status: 404 });
    case "not_reprocessable":
      return Response.json(
        {
          error: `document status is "${outcome.document.status}" — only done documents can be reprocessed`,
          status: outcome.document.status,
        },
        { status: 409 },
      );
    case "reprocessed":
      return Response.json({
        document: outcome.document,
        jobId: outcome.jobId,
        enqueued: outcome.jobId !== null,
      });
  }
}
