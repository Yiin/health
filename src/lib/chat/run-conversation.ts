// One chat turn: persist the user message, replay history to Kimi with tool
// calling, dispatch tools against the user's data, persist the assistant
// answer (with its tool rounds + citations so later turns can replay the
// full exchange), and stream progress as ChatEvents (carried over SSE by
// the route handler).

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import {
  addMessage,
  createConversation,
  deriveTitle,
  getConversation,
  listRecentMessages,
} from "../../db/repos/conversations";
import type {
  ChatCitation,
  Message,
  StoredToolRounds,
} from "../../db/schema";
import type * as schema from "../../db/schema";
import { KimiError } from "../kimi/client";

import {
  chatCompletionWithTools,
  type ToolCallRequest,
} from "./kimi-chat";
import { buildSystemPrompt } from "./system-prompt";
import { CHAT_TOOLS, dispatchTool } from "./tools";

type Db = PostgresJsDatabase<typeof schema>;

export type ChatEvent =
  | { type: "conversation"; conversationId: string; title: string }
  | { type: "tool"; name: string; status: "started" | "done" }
  | { type: "delta"; text: string }
  | { type: "citations"; citations: ChatCitation[] }
  | { type: "done"; conversationId: string; messageId: string }
  | { type: "error"; message: string };

/** Hard cap on tool-calling rounds per user turn. */
const MAX_TOOL_ROUNDS = 8;
/** Messages replayed as model context (user + assistant rows). */
const HISTORY_LIMIT = 12;
/** Approximate chunk size for delta events. */
const DELTA_CHUNK_CHARS = 80;

export class ChatError extends Error {}

/** Replays persisted rows into the Kimi message array. */
export function toKimiMessages(history: Message[]): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];
  for (const message of history) {
    if (message.role === "user") {
      params.push({ role: "user", content: message.content });
      continue;
    }
    // Assistant turn: replay each stored tool round (assistant tool_calls +
    // one tool result message per call), then the final answer. Kimi thinking
    // models reject histories whose assistant messages lack reasoning_content.
    for (const round of message.toolCalls?.rounds ?? []) {
      params.push({
        role: "assistant",
        content: null,
        tool_calls: round.calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
        ...(round.reasoningContent
          ? { reasoning_content: round.reasoningContent }
          : {}),
      } as unknown as ChatCompletionMessageParam);
      for (const call of round.calls) {
        params.push({
          role: "tool",
          tool_call_id: call.id,
          content: call.result,
        });
      }
    }
    params.push({
      role: "assistant",
      content: message.content,
      ...(message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}),
    } as unknown as ChatCompletionMessageParam);
  }
  return params;
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Splits the final answer into small chunks for delta events. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DELTA_CHUNK_CHARS) {
    let cut = remaining.lastIndexOf(" ", DELTA_CHUNK_CHARS);
    if (cut <= 0) cut = DELTA_CHUNK_CHARS;
    chunks.push(remaining.slice(0, cut + 1));
    remaining = remaining.slice(cut + 1);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface RunChatTurnParams {
  db: Db;
  /** Existing conversation; a new one is created when omitted. */
  conversationId?: string;
  message: string;
  emit: (event: ChatEvent) => void;
  /** Model override (tests, escalations). Defaults to KIMI_MODELS.chat. */
  model?: string;
}

export interface RunChatTurnResult {
  conversationId: string;
  messageId: string;
  content: string;
  citations: ChatCitation[];
}

async function listBiomarkerCatalog(db: Db) {
  const rows = await db.execute(
    sql`select slug, name, canonical_unit from biomarkers order by slug`,
  );
  return rows.map((row) => ({
    slug: row.slug as string,
    name: row.name as string,
    canonicalUnit: row.canonical_unit as string,
  }));
}

export async function runChatTurn(
  params: RunChatTurnParams,
): Promise<RunChatTurnResult> {
  const { db, emit } = params;
  const message = params.message.trim();
  if (!message) throw new ChatError("Message must not be empty");

  let conversation;
  if (params.conversationId) {
    conversation = await getConversation(db, params.conversationId);
    if (!conversation) throw new ChatError("Conversation not found");
  } else {
    conversation = await createConversation(db, deriveTitle(message));
  }
  emit({
    type: "conversation",
    conversationId: conversation.id,
    title: conversation.title,
  });

  await addMessage(db, {
    conversationId: conversation.id,
    role: "user",
    content: message,
  });

  const [history, catalog] = await Promise.all([
    listRecentMessages(db, conversation.id, HISTORY_LIMIT),
    listBiomarkerCatalog(db),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  let kimiMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(catalog, today) },
    ...toKimiMessages(history),
  ];

  const citations: ChatCitation[] = [];
  const rounds: StoredToolRounds["rounds"] = [];
  let content = "";
  let reasoningContent: string | undefined;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    let completion;
    try {
      completion = await chatCompletionWithTools({
        messages: kimiMessages,
        tools: CHAT_TOOLS as unknown as ChatCompletionTool[],
        model: params.model,
      });
    } catch (error) {
      // A long thread can overflow the context window; retry with the
      // oldest history dropped (system + the latest user message stay).
      if (error instanceof KimiError && error.kind === "context-overflow") {
        if (kimiMessages.length > 2) {
          kimiMessages = [kimiMessages[0], kimiMessages[kimiMessages.length - 1]];
          continue;
        }
        throw new ChatError(
          "This conversation is too long for the model — start a new chat.",
        );
      }
      throw error;
    }

    if (completion.toolCalls.length === 0) {
      content = completion.content ?? "";
      reasoningContent = completion.reasoningContent;
      break;
    }

    // Append the assistant tool-call message, then dispatch each call and
    // append its tool result message.
    kimiMessages.push({
      role: "assistant",
      content: completion.content,
      tool_calls: completion.toolCalls.map((call: ToolCallRequest) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.argumentsJson },
      })),
      ...(completion.reasoningContent
        ? { reasoning_content: completion.reasoningContent }
        : {}),
    } as unknown as ChatCompletionMessageParam);

    const roundRecord: StoredToolRounds["rounds"][number] = {
      calls: [],
      ...(completion.reasoningContent
        ? { reasoningContent: completion.reasoningContent }
        : {}),
    };
    for (const call of completion.toolCalls) {
      emit({ type: "tool", name: call.name, status: "started" });
      const args = parseArguments(call.argumentsJson);
      const result = await dispatchTool(db, call.name, args, citations);
      emit({ type: "tool", name: call.name, status: "done" });
      kimiMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
      roundRecord.calls.push({
        id: call.id,
        name: call.name,
        arguments: args,
        result,
      });
    }
    rounds.push(roundRecord);
  }

  if (!content) {
    content =
      "I wasn't able to finish looking that up — please try rephrasing the question.";
  }

  const assistantMessage = await addMessage(db, {
    conversationId: conversation.id,
    role: "assistant",
    content,
    toolCalls: rounds.length > 0 ? { rounds } : undefined,
    citations,
    reasoningContent,
  });

  emit({ type: "citations", citations });
  for (const chunk of chunkText(content)) {
    emit({ type: "delta", text: chunk });
  }
  emit({
    type: "done",
    conversationId: conversation.id,
    messageId: assistantMessage.id,
  });

  return {
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    content,
    citations,
  };
}
