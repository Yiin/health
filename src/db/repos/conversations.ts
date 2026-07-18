// Repository for the chat tables (conversations + messages). Pure functions
// taking the drizzle db handle as their first argument — same pattern as the
// other repos (see src/db/repos/documents.ts).

import { and, asc, desc, eq, ilike } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  conversations,
  messages,
  type ChatCitation,
  type Conversation,
  type Message,
  type MessageRole,
  type StoredToolRounds,
} from "../schema";
import type * as schema from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

/** Derives a conversation title from the first user message. */
export function deriveTitle(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  const max = 60;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export async function createConversation(
  db: Db,
  title = "New conversation",
): Promise<Conversation> {
  const rows = await db.insert(conversations).values({ title }).returning();
  return rows[0];
}

export interface ConversationListFilter {
  /** Case-insensitive substring match on the title. */
  query?: string;
  /** When set, only archived (true) or only active (false) conversations. */
  archived?: boolean;
  limit?: number;
  offset?: number;
}

/** Conversation list for the /chat sidebar, newest first. */
export async function listConversations(
  db: Db,
  filter: ConversationListFilter = {},
): Promise<Conversation[]> {
  const conditions = [
    filter.archived !== undefined
      ? eq(conversations.archived, filter.archived)
      : undefined,
    filter.query ? ilike(conversations.title, `%${filter.query}%`) : undefined,
  ];
  return db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.createdAt))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);
}

export async function getConversation(
  db: Db,
  conversationId: string,
): Promise<Conversation | undefined> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0];
}

/** Sets title and/or archived; returns the updated row. */
export async function updateConversation(
  db: Db,
  conversationId: string,
  patch: { title?: string; archived?: boolean },
): Promise<Conversation | undefined> {
  const updated = await db
    .update(conversations)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    })
    .where(eq(conversations.id, conversationId))
    .returning();
  return updated[0];
}

export interface NewMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls?: StoredToolRounds;
  citations?: ChatCitation[];
  reasoningContent?: string;
}

export async function addMessage(
  db: Db,
  input: NewMessageInput,
): Promise<Message> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      citations: input.citations ?? null,
      reasoningContent: input.reasoningContent ?? null,
    })
    .returning();
  return rows[0];
}

/** Full thread, oldest first. */
export async function listMessages(
  db: Db,
  conversationId: string,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/**
 * The most recent messages for model context, oldest first. Implemented as a
 * newest-first limited select reversed, so a long thread doesn't blow the
 * model's context window.
 */
export async function listRecentMessages(
  db: Db,
  conversationId: string,
  limit: number,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}
