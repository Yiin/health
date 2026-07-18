"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SendHorizonal } from "lucide-react";

import {
  ConversationList,
  type ConversationSummary,
} from "./conversation-list";
import type { Citation } from "./citation-card";
import {
  MessageThread,
  type ClientMessage,
  type StreamingState,
} from "./message-thread";

const TOOL_LABELS: Record<string, string> = {
  search_documents: "Searching documents…",
  get_biomarker_trend: "Reading lab results…",
  get_daily_metrics: "Reading wearable metrics…",
  get_document: "Opening document…",
};

interface ChatEventFrame {
  event: string;
  data: string;
}

function parseFrames(buffer: string): {
  frames: ChatEventFrame[];
  rest: string;
} {
  const frames: ChatEventFrame[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) frames.push({ event, data });
  }
  return { frames, rest };
}

export function ChatClient() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    params.set("archived", showArchived ? "1" : "0");
    const response = await fetch(`/api/chat/conversations?${params}`);
    if (!response.ok) return;
    const body = (await response.json()) as {
      conversations: ConversationSummary[];
    };
    setConversations(body.conversations);
  }, [search, showArchived]);

  useEffect(() => {
    // Debounced so typing in the search box doesn't fire a fetch per key.
    const timer = setTimeout(() => void loadConversations(), 150);
    return () => clearTimeout(timer);
  }, [loadConversations]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function selectConversation(id: string) {
    if (streaming) return;
    setError(null);
    setActiveId(id);
    const response = await fetch(`/api/chat/conversations/${id}`);
    if (!response.ok) {
      setMessages([]);
      return;
    }
    const body = (await response.json()) as { messages: ClientMessage[] };
    setMessages(body.messages);
  }

  function startNewChat() {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setError(null);
  }

  async function setArchived(id: string, archived: boolean) {
    await fetch(`/api/chat/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (activeId === id && archived !== showArchived) {
      setActiveId(null);
      setMessages([]);
    }
    await loadConversations();
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);

    const userMessage: ClientMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      citations: [],
    };
    setMessages((prev) => [...prev, userMessage]);

    const state: StreamingState = {
      content: "",
      citations: [],
      toolActivity: "Thinking…",
    };
    setStreaming({ ...state });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(activeId ? { conversationId: activeId } : {}),
          message: text,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const data = JSON.parse(frame.data) as {
            conversationId?: string;
            name?: string;
            status?: "started" | "done";
            citations?: Citation[];
            text?: string;
            message?: string;
          };
          if (frame.event === "conversation" && data.conversationId) {
            setActiveId(data.conversationId);
          } else if (frame.event === "tool" && data.name) {
            state.toolActivity =
              data.status === "started"
                ? (TOOL_LABELS[data.name] ?? `Running ${data.name}…`)
                : "Thinking…";
          } else if (frame.event === "citations") {
            state.citations = data.citations ?? [];
          } else if (frame.event === "delta") {
            state.content += data.text ?? "";
          } else if (frame.event === "error") {
            throw new Error(data.message ?? "Chat request failed");
          }
          setStreaming({ ...state });
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `local-assistant-${Date.now()}`,
          role: "assistant",
          content: state.content,
          citations: state.citations,
        },
      ]);
      setStreaming(null);
      await loadConversations();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreaming(null);
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="flex h-full gap-4">
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        showArchived={showArchived}
        search={search}
        onSearch={setSearch}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onSelect={(id) => void selectConversation(id)}
        onNew={startNewChat}
        onSetArchived={(id, archived) => void setArchived(id, archived)}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <MessageThread messages={messages} streaming={streaming} />

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about your health data…"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || streaming !== null}
            title="Send"
            className="rounded-lg bg-primary p-2.5 text-primary-foreground transition-opacity disabled:opacity-40"
          >
            <SendHorizonal className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
