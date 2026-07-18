"use client";

import { useEffect, useState } from "react";
import { HeartPulse } from "lucide-react";

import type { IngestionHealth } from "@/lib/ingestion-health";

const POLL_INTERVAL_MS = 10_000;

/**
 * Pipeline health line for the upload page, fed by GET /api/ingestion/health:
 * queue depth (waiting + running jobs) plus the failed / needs-review
 * document counts. Unlike the per-document feed below it, this covers the
 * WHOLE database — old failures included — so it is the "is the pipeline
 * healthy" answer, not a recent-activity view.
 */
export function IngestionHealthStrip() {
  const [health, setHealth] = useState<IngestionHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/ingestion/health");
        if (!response.ok) return;
        const data = (await response.json()) as { ok: boolean } & IngestionHealth;
        if (!cancelled && data.ok) {
          setHealth({ queue: data.queue, documents: data.documents });
        }
      } catch {
        // Transient fetch failure — keep the last snapshot.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!health) return null;

  const { queue, documents } = health;
  const busy = queue.queued + queue.active > 0;
  const attention = documents.failed > 0 || documents.needsReview > 0;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
      <HeartPulse
        className={
          busy
            ? "size-3.5 shrink-0 animate-pulse text-sky-400"
            : attention
              ? "size-3.5 shrink-0 text-amber-400"
              : "size-3.5 shrink-0 text-emerald-400"
        }
      />
      <span className="font-medium">Pipeline</span>
      <span className="text-muted-foreground">
        queue {queue.queued} waiting · {queue.active} running
        {" — "}
        <span className={documents.failed > 0 ? "text-red-400" : undefined}>
          {documents.failed} failed
        </span>
        {" · "}
        <span
          className={documents.needsReview > 0 ? "text-amber-400" : undefined}
        >
          {documents.needsReview} need review
        </span>
        {documents.processing > 0
          ? ` · ${documents.processing} processing`
          : ""}
      </span>
    </div>
  );
}
