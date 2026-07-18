import { DOCUMENT_TYPES, type DocumentType } from "@/db/schema";
import { resetDocumentForRetry } from "@/lib/uploads";

type DocumentTypeHint =
  | { ok: true; documentType?: DocumentType }
  | { ok: false; error: string };

/**
 * Reads the optional JSON body of a retry POST. No JSON content type means a
 * plain retry; a body may carry the "Process as…" hint
 * (`{ "documentType": "lab_report" }`).
 */
async function parseDocumentTypeHint(
  request: Request,
): Promise<DocumentTypeHint> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return { ok: true };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const { documentType } = body as Record<string, unknown>;
  if (documentType === undefined) {
    return { ok: true };
  }
  if (
    typeof documentType !== "string" ||
    !(DOCUMENT_TYPES as readonly string[]).includes(documentType)
  ) {
    return {
      ok: false,
      error: `documentType must be one of: ${DOCUMENT_TYPES.join(", ")}`,
    };
  }
  return { ok: true, documentType: documentType as DocumentType };
}

/**
 * Re-enqueues ingestion for a document whose pipeline run ended in `failed`
 * or `needs_review`: status returns to `uploaded`, stage_error is cleared,
 * attempts is preserved, and a fresh ingest job is enqueued (atomically with
 * the status reset). 404 for unknown ids, 409 for any other status.
 *
 * An optional JSON body `{ documentType }` ("Process as…") stores the type
 * hint as a metadata override in the same transaction before re-enqueueing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const hint = await parseDocumentTypeHint(request);
  if (!hint.ok) {
    return Response.json({ error: hint.error }, { status: 400 });
  }

  const outcome = await resetDocumentForRetry(id, {
    ...(hint.documentType ? { documentType: hint.documentType } : {}),
  });

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
