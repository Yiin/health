"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2 } from "lucide-react";

import { CitationCard, type Citation } from "./citation-card";

export interface ClientMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
}

export interface StreamingState {
  content: string;
  citations: Citation[];
  toolActivity: string | null;
}

// No typography plugin in this project; map elements to Tailwind classes.
const markdownComponents: React.ComponentProps<
  typeof ReactMarkdown
>["components"] = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 text-lg font-semibold">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 text-base font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 text-sm font-semibold">{children}</h3>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  a: ({ children, href }) => (
    <a href={href} className="text-primary underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-muted p-3 text-sm last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-3 italic last:mb-0">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

function AssistantBody({
  content,
  citations,
}: {
  content: string;
  citations: Citation[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </div>
      {citations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Sources</p>
          {citations.map((citation, i) => (
            <CitationCard key={`${citation.documentId}-${i}`} citation={citation} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageThread({
  messages,
  streaming,
}: {
  messages: ClientMessage[];
  streaming: StreamingState | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming?.content, streaming?.toolActivity]);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {messages.length === 0 && !streaming && (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Ask about your labs, vitals, or documents — e.g. “how has my ferritin
          changed?”. Answers cite the sources they were built from.
        </div>
      )}
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              {message.content}
            </div>
          </div>
        ) : (
          <div key={message.id} className="max-w-[85%]">
            <AssistantBody content={message.content} citations={message.citations} />
          </div>
        ),
      )}
      {streaming && (
        <div className="max-w-[85%]">
          {streaming.content ? (
            <AssistantBody
              content={streaming.content}
              citations={streaming.citations}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {streaming.toolActivity ?? "Thinking…"}
            </div>
          )}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
