// GET /api/chat/conversations?q=&archived=0|1 — the /chat sidebar list.

import { db } from "@/db";
import { listConversations } from "@/db/repos/conversations";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || undefined;
  const archivedParam = url.searchParams.get("archived");
  const archived =
    archivedParam === "1" ? true : archivedParam === "0" ? false : undefined;

  const conversations = await listConversations(db, {
    query,
    archived,
    limit: 100,
  });
  return Response.json({ conversations });
}
