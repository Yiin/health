import { db } from "@/db";
import { listIngestionFeed } from "@/db/repos/documents";
import { isNonTerminalStatus } from "@/db/schema";

/**
 * Live ingestion feed, polled by the upload page and the overview status
 * strip. `?status=active` returns every document whose pipeline run is still
 * in flight plus recent terminal outcomes (see listIngestionFeed), newest
 * first, and `hasActive` telling the poller whether to keep polling.
 * Auth is enforced by the proxy matcher (same as the other /api routes).
 */
export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status");
  if (status !== "active") {
    return Response.json(
      { error: "unsupported query — only ?status=active is available" },
      { status: 400 },
    );
  }

  const documents = await listIngestionFeed(db);
  return Response.json({
    documents,
    hasActive: documents.some((doc) => isNonTerminalStatus(doc.status)),
    polledAt: new Date().toISOString(),
  });
}
