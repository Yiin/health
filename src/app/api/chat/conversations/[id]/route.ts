// GET   /api/chat/conversations/[id] — one conversation with its thread.
// PATCH /api/chat/conversations/[id] — rename and/or archive.

import { db } from "@/db";
import {
  getConversation,
  listMessages,
  updateConversation,
} from "@/db/repos/conversations";

function toClientMessage(message: {
  id: string;
  role: string;
  content: string;
  citations: unknown;
  createdAt: Date;
}) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations ?? [],
    createdAt: message.createdAt,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conversation = await getConversation(db, id);
  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }
  const thread = await listMessages(db, id);
  return Response.json({
    conversation,
    messages: thread.map(toClientMessage),
  });
}

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
  const { title, archived } = (body ?? {}) as {
    title?: unknown;
    archived?: unknown;
  };
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    return Response.json(
      { error: "title must be a non-empty string" },
      { status: 400 },
    );
  }
  if (archived !== undefined && typeof archived !== "boolean") {
    return Response.json(
      { error: "archived must be a boolean" },
      { status: 400 },
    );
  }

  const updated = await updateConversation(db, id, {
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(archived !== undefined ? { archived } : {}),
  });
  if (!updated) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }
  return Response.json({ conversation: updated });
}
