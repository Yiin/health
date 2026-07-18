// Mocked-Kimi end-to-end tests: a full conversation turn against the test
// database, with fetch stubbed to script Kimi's responses. Verifies tool
// dispatch, reasoning_content echo, citation persistence, and the decline
// path.

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerUpload, updateExtraction } from "../../db/repos/documents";
import { listMessages } from "../../db/repos/conversations";
import { biomarkers } from "../../db/schema";
import { setupTestDb } from "../../db/test-utils";

import { chunkText, ChatError, runChatTurn, type ChatEvent } from "./run-conversation";
import { encodeSseEvent, parseSseEvent } from "./sse";

const getDb = setupTestDb();

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubEnv("MOONSHOT_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function completionResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolCallCompletion(
  name: string,
  args: unknown,
  reasoning: string,
  callId = "call_1",
) {
  return completionResponse({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "kimi-k2.6",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: reasoning,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function finalCompletion(content: string, reasoning = "final reasoning") {
  return completionResponse({
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1_700_000_001,
    model: "kimi-k2.6",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning_content: reasoning },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}

function requestBody(callIndex: number) {
  const init = fetchMock.mock.calls[callIndex][1];
  return JSON.parse(String(init?.body)) as {
    messages: Array<Record<string, unknown>>;
    tools: unknown[];
  };
}

async function seedFerritinReport() {
  const db = getDb();
  const { document } = await registerUpload(db, {
    sha256: `sha-${Math.random().toString(36).slice(2)}`,
    filename: "hila-lab-report.pdf",
    s3Key: "originals/ab/abcdef",
    contentType: "application/pdf",
  });
  await updateExtraction(db, document.id, {
    documentType: "lab_report",
    provider: "UAB Hila",
    documentDate: "2026-01-05",
    aiSummary: "Lab report with ferritin results.",
    extractedText: "Ferritin 45 ng/mL reference 10-120.",
  });
  const [biomarker] = await db
    .insert(biomarkers)
    .values({
      slug: "ferritin",
      name: "Ferritin",
      category: "iron",
      canonicalUnit: "ng/mL",
    })
    .returning();
  await db.execute(sql`
    insert into biomarker_results
      (biomarker_id, measured_on, value, unit, value_canonical, ref_text, lab_name, flag, document_id)
    values
      (${biomarker.id}, '2025-06-01', 30, 'ng/mL', 30, '10-120', 'UAB Hila', 'normal', ${document.id}),
      (${biomarker.id}, '2026-01-05', 45, 'ng/mL', 45, '10-120', 'UAB Hila', 'normal', ${document.id})`);
  return document;
}

function collectEvents(): { events: ChatEvent[]; emit: (e: ChatEvent) => void } {
  const events: ChatEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

describe("runChatTurn (mocked Kimi e2e)", () => {
  it("answers 'how has my ferritin changed' with a persisted citation", async () => {
    const document = await seedFerritinReport();
    fetchMock
      .mockResolvedValueOnce(
        toolCallCompletion(
          "get_biomarker_trend",
          { slug: "ferritin" },
          "need the trend first",
        ),
      )
      .mockResolvedValueOnce(
        finalCompletion(
          "Your ferritin rose from 30 ng/mL (2025-06-01) to 45 ng/mL (2026-01-05), still within the reference range (hila-lab-report.pdf).",
        ),
      );

    const { events, emit } = collectEvents();
    const result = await runChatTurn({
      db: getDb(),
      message: "how has my ferritin changed?",
      emit,
    });

    // Two Kimi calls: tool-call round, then the final answer.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The second request echoes the tool exchange AND reasoning_content.
    const second = requestBody(1);
    const assistantWithTools = second.messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantWithTools).toMatchObject({
      reasoning_content: "need the trend first",
    });
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call_1" });
    expect(String(toolMessage?.content)).toContain('"value":30');
    expect(String(toolMessage?.content)).toContain('"value":45');
    // System prompt carries the catalog + the health-only restriction.
    const system = String(second.messages[0].content);
    expect(system).toContain("ferritin (Ferritin");
    expect(system).toContain("politely decline");

    // Citation points at the source document.
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].documentId).toBe(document.id);
    expect(result.citations[0].quote).toContain("Ferritin: 30 ng/mL");

    // Event stream: conversation → tool started/done → citations → deltas → done.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("conversation");
    expect(types).toContain("tool");
    expect(types).toContain("citations");
    expect(types[types.length - 1]).toBe("done");
    const deltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e.type === "delta" ? e.text : ""));
    expect(deltas.join("")).toBe(result.content);

    // Persisted: conversation with derived title, user + assistant messages.
    const thread = await listMessages(getDb(), result.conversationId);
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ role: "user", content: "how has my ferritin changed?" });
    expect(thread[1]).toMatchObject({ role: "assistant", content: result.content });
    expect(thread[1].toolCalls?.rounds[0].calls[0]).toMatchObject({
      name: "get_biomarker_trend",
      arguments: { slug: "ferritin" },
    });
    expect(thread[1].citations?.[0].documentId).toBe(document.id);
    expect(thread[1].reasoningContent).toBe("final reasoning");
  });

  it("replays the previous turn's tool rounds on the next turn", async () => {
    const document = await seedFerritinReport();
    fetchMock
      .mockResolvedValueOnce(
        toolCallCompletion(
          "get_biomarker_trend",
          { slug: "ferritin" },
          "round one reasoning",
        ),
      )
      .mockResolvedValueOnce(finalCompletion("It rose to 45 ng/mL."));
    const first = await runChatTurn({
      db: getDb(),
      message: "ferritin?",
      emit: () => {},
    });

    fetchMock.mockResolvedValueOnce(finalCompletion("Still 45 ng/mL."));
    await runChatTurn({
      db: getDb(),
      conversationId: first.conversationId,
      message: "and this year?",
      emit: () => {},
    });

    const second = requestBody(2);
    const replayedAssistant = second.messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(replayedAssistant).toMatchObject({
      reasoning_content: "round one reasoning",
    });
    const replayedTool = second.messages.find((m) => m.role === "tool");
    expect(String(replayedTool?.content)).toContain('"value":45');
    expect(document.id).toBeTruthy();
  });

  it("declines a non-health question without calling tools", async () => {
    fetchMock.mockResolvedValueOnce(
      finalCompletion(
        "I can only help with questions about your health data — for example your lab results or wearable metrics.",
      ),
    );
    const { events, emit } = collectEvents();
    const result = await runChatTurn({
      db: getDb(),
      message: "what is the capital of France?",
      emit,
    });

    expect(result.content).toContain("health data");
    expect(result.citations).toEqual([]);
    expect(events.some((e) => e.type === "tool")).toBe(false);
    const thread = await listMessages(getDb(), result.conversationId);
    expect(thread[1].toolCalls).toBeNull();
    expect(thread[1].citations).toEqual([]);
  });

  it("rejects empty messages and unknown conversations", async () => {
    await expect(
      runChatTurn({ db: getDb(), message: "   ", emit: () => {} }),
    ).rejects.toBeInstanceOf(ChatError);
    await expect(
      runChatTurn({
        db: getDb(),
        conversationId: "00000000-0000-0000-0000-000000000000",
        message: "hi",
        emit: () => {},
      }),
    ).rejects.toBeInstanceOf(ChatError);
  });
});

describe("chunkText", () => {
  it("splits on word boundaries and round-trips", () => {
    const text = "word ".repeat(50).trim();
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join("")).toBe(text);
    expect(chunkText("short")).toEqual(["short"]);
  });
});

describe("SSE framing", () => {
  it("encodes events parseable by the client", () => {
    const event: ChatEvent = { type: "delta", text: "hello " };
    const raw = new TextDecoder().decode(encodeSseEvent(event));
    expect(raw.startsWith("event: delta\n")).toBe(true);
    expect(parseSseEvent(raw.trimEnd())).toEqual(event);
  });
});
