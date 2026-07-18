// POST /api/chat — one chat turn over the user's health data. Responds with
// an SSE stream of ChatEvents: conversation → tool started/done → citations
// → delta chunks → done (or a single error event).

import { db } from "@/db";
import { getConversation } from "@/db/repos/conversations";
import {
  ChatError,
  runChatTurn,
  type ChatEvent,
} from "@/lib/chat/run-conversation";
import { encodeSseEvent } from "@/lib/chat/sse";
import { toKimiError } from "@/lib/kimi/client";

const MAX_MESSAGE_CHARS = 4000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { conversationId, message } = (body ?? {}) as {
    conversationId?: unknown;
    message?: unknown;
  };
  if (typeof message !== "string" || !message.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: `message is too long (max ${MAX_MESSAGE_CHARS} chars)` },
      { status: 400 },
    );
  }
  if (conversationId !== undefined && typeof conversationId !== "string") {
    return Response.json(
      { error: "conversationId must be a string" },
      { status: 400 },
    );
  }
  if (typeof conversationId === "string") {
    const existing = await getConversation(db, conversationId);
    if (!existing) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        controller.enqueue(encodeSseEvent(event));
      };
      try {
        await runChatTurn({ db, conversationId, message, emit });
      } catch (error) {
        emit({
          type: "error",
          message:
            error instanceof ChatError
              ? error.message
              : toKimiError(error).message,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
