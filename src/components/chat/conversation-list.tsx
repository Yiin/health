"use client";

import { Archive, ArchiveRestore, MessageSquare, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
}

export function ConversationList({
  conversations,
  activeId,
  showArchived,
  search,
  onSearch,
  onToggleArchived,
  onSelect,
  onNew,
  onSetArchived,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  showArchived: boolean;
  search: string;
  onSearch: (value: string) => void;
  onToggleArchived: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSetArchived: (id: string, archived: boolean) => void;
}) {
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search chats"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={onNew}
          title="New chat"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto">
        {conversations.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {showArchived ? "No archived chats." : "No chats yet."}
          </p>
        )}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={cn(
              "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors",
              conversation.id === activeId
                ? "bg-accent text-accent-foreground"
                : "text-foreground/80 hover:bg-muted",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={conversation.title}
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{conversation.title}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onSetArchived(conversation.id, !conversation.archived)
              }
              title={conversation.archived ? "Unarchive" : "Archive"}
              className="hidden shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            >
              {conversation.archived ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onToggleArchived}
        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {showArchived ? "Back to active chats" : "Show archived"}
      </button>
    </div>
  );
}
