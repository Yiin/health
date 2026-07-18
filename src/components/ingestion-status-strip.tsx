"use client";

import Link from "next/link";
import { Activity, ArrowRight } from "lucide-react";

import { isNonTerminalStatus } from "@/db/schema";

import { useIngestionFeed } from "./upload/use-ingestion-feed";

/**
 * Condensed live-ingestion strip for the overview page: one line of counts
 * (processing / needs review / failed / recently done) linking to /upload
 * for the full feed. Renders nothing when there is no recent activity.
 */
export function IngestionStatusStrip() {
  const { documents, hasActive, loaded } = useIngestionFeed();

  if (!loaded || documents.length === 0) return null;

  const processing = documents.filter((doc) =>
    isNonTerminalStatus(doc.status),
  ).length;
  const needsReview = documents.filter(
    (doc) => doc.status === "needs_review",
  ).length;
  const failed = documents.filter((doc) => doc.status === "failed").length;
  const done = documents.filter((doc) => doc.status === "done").length;

  const parts = [
    processing > 0
      ? `${processing} processing`
      : null,
    needsReview > 0 ? `${needsReview} needs review` : null,
    failed > 0 ? `${failed} failed` : null,
    done > 0 ? `${done} done` : null,
  ].filter(Boolean);

  if (parts.length === 0) return null;

  return (
    <Link
      href="/upload"
      className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/40"
    >
      <Activity
        className={
          hasActive ? "size-4 shrink-0 animate-pulse text-sky-400" : "size-4 shrink-0 text-muted-foreground"
        }
      />
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">Ingestion</span>
        <span className="text-muted-foreground"> — {parts.join(" · ")}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
