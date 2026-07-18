import { resetDocumentForRetry } from "@/lib/uploads";

/**
 * Re-enqueues ingestion for a document whose pipeline run ended in `failed`
 * or `needs_review`: status returns to `uploaded`, stage_error is cleared,
 * attempts is preserved, and a fresh ingest job is enqueued (atomically with
 * the status reset). 404 for unknown ids, 409 for any other status.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const outcome = await resetDocumentForRetry(id);

  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "unknown document" }, { status: 404 });
    case "not_retryable":
      return Response.json(
        {
          error: `document status is "${outcome.document.status}" — only failed or needs_review documents can be retried`,
          status: outcome.document.status,
        },
        { status: 409 },
      );
    case "retried":
      return Response.json({
        document: outcome.document,
        jobId: outcome.jobId,
        enqueued: outcome.jobId !== null,
      });
  }
}
