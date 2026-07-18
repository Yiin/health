import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversations } from "../schema";
import { setupTestDb } from "../test-utils";
import {
  addMessage,
  createConversation,
  deriveTitle,
  getConversation,
  listConversations,
  listMessages,
  listRecentMessages,
  updateConversation,
} from "./conversations";

const getDb = setupTestDb();

describe("deriveTitle", () => {
  it("collapses whitespace and truncates long messages", () => {
    expect(deriveTitle("  how has\nmy  ferritin changed? ")).toBe(
      "how has my ferritin changed?",
    );
    const long = deriveTitle("x".repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("conversations repo", () => {
  it("creates, fetches, and updates a conversation", async () => {
    const db = getDb();
    const conversation = await createConversation(db, "ferritin trend");
    expect(conversation.title).toBe("ferritin trend");
    expect(conversation.archived).toBe(false);

    expect(await getConversation(db, conversation.id)).toMatchObject({
      title: "ferritin trend",
    });

    const updated = await updateConversation(db, conversation.id, {
      archived: true,
      title: "old chat",
    });
    expect(updated).toMatchObject({ archived: true, title: "old chat" });
  });

  it("lists conversations with archived filter and title search", async () => {
    const db = getDb();
    const active = await createConversation(db, "Ferritin questions");
    const archived = await createConversation(db, "Sleep data");
    await updateConversation(db, archived.id, { archived: true });

    const activeOnly = await listConversations(db, { archived: false });
    expect(activeOnly.map((c) => c.id)).toEqual([active.id]);

    const archivedOnly = await listConversations(db, { archived: true });
    expect(archivedOnly.map((c) => c.id)).toEqual([archived.id]);

    const found = await listConversations(db, { query: "ferritin" });
    expect(found.map((c) => c.id)).toEqual([active.id]);

    expect(await listConversations(db, { query: "no such title" })).toEqual(
      [],
    );
  });

  it("stores and returns messages in order, with tool calls and citations", async () => {
    const db = getDb();
    const conversation = await createConversation(db);
    await addMessage(db, {
      conversationId: conversation.id,
      role: "user",
      content: "how has my ferritin changed",
    });
    await addMessage(db, {
      conversationId: conversation.id,
      role: "assistant",
      content: "It rose from 30 to 45 ng/mL.",
      toolCalls: {
        rounds: [
          {
            reasoningContent: "need the trend",
            calls: [
              {
                id: "call_1",
                name: "get_biomarker_trend",
                arguments: { slug: "ferritin" },
                result: '{"points":[]}',
              },
            ],
          },
        ],
      },
      citations: [
        { documentId: "doc-1", filename: "lab.pdf", quote: "Ferritin 45" },
      ],
      reasoningContent: "final reasoning",
    });

    const thread = await listMessages(db, conversation.id);
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ role: "user" });
    expect(thread[1]).toMatchObject({
      role: "assistant",
      reasoningContent: "final reasoning",
    });
    expect(thread[1].toolCalls?.rounds[0].calls[0]).toMatchObject({
      name: "get_biomarker_trend",
    });
    expect(thread[1].citations?.[0]).toMatchObject({ documentId: "doc-1" });
  });

  it("listRecentMessages returns the newest N, oldest first", async () => {
    const db = getDb();
    const conversation = await createConversation(db);
    for (let i = 1; i <= 5; i += 1) {
      await addMessage(db, {
        conversationId: conversation.id,
        role: "user",
        content: `message ${i}`,
      });
    }
    const recent = await listRecentMessages(db, conversation.id, 2);
    expect(recent.map((m) => m.content)).toEqual(["message 4", "message 5"]);
  });

  it("cascades message deletion with the conversation", async () => {
    const db = getDb();
    const conversation = await createConversation(db);
    await addMessage(db, {
      conversationId: conversation.id,
      role: "user",
      content: "hi",
    });
    await db.delete(conversations).where(eq(conversations.id, conversation.id));
    expect(await listMessages(db, conversation.id)).toEqual([]);
  });
});
