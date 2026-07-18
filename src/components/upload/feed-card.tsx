"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";

import { DOCUMENT_TYPES, type DocumentType } from "@/db/schema";
import {
  describeVerdict,
  formatSize,
  INGESTION_STAGES,
  stageVisuals,
  type FeedDocument,
  type StageVisual,
} from "@/lib/ingestion-feed";
import { cn } from "@/lib/utils";
import { humanize, StatusBadge } from "@/components/documents/badges";
import { Button } from "@/components/ui/button";

const PROCESS_AS_TYPES = DOCUMENT_TYPES.filter((type) => type !== "unknown");

const STEP_ICON: Record<StageVisual, React.ReactNode> = {
  done: <Check className="size-3" />,
  current: <Loader2 className="size-3 animate-spin" />,
  failed: <X className="size-3" />,
  review: <AlertTriangle className="size-3" />,
  upcoming: null,
};

const STEP_CLASSES: Record<StageVisual, string> = {
  done: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
  current: "border-sky-400/40 bg-sky-400/10 text-sky-400",
  failed: "border-red-400/40 bg-red-400/10 text-red-400",
  review: "border-amber-400/40 bg-amber-400/10 text-amber-400",
  upcoming: "border-border bg-muted text-muted-foreground/50",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function StageStepper({ doc }: { doc: FeedDocument }) {
  const visuals = stageVisuals(doc);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {INGESTION_STAGES.map((stage, index) => {
        const visual = visuals[stage];
        const observed = doc.observedAt[stage];
        return (
          <li key={stage} className="flex items-center gap-1">
            {index > 0 && (
              <span aria-hidden className="h-px w-3 bg-border" />
            )}
            <span className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border",
                  STEP_CLASSES[visual],
                )}
              >
                {STEP_ICON[visual]}
              </span>
              <span
                className={cn(
                  "text-[10px] leading-none whitespace-nowrap",
                  visual === "upcoming"
                    ? "text-muted-foreground/50"
                    : "text-muted-foreground",
                )}
              >
                {humanize(stage)}
                {observed && visual !== "upcoming" && (
                  <span className="block text-center text-[9px] text-muted-foreground/60">
                    {formatTime(observed)}
                  </span>
                )}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One live-feed document: pipeline stepper, the classifier's verdict once
 * known, and recovery actions for terminal trouble (Retry always;
 * "Process as…" additionally for needs_review).
 */
export function FeedCard({
  doc,
  onAction,
}: {
  doc: FeedDocument;
  onAction: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processType, setProcessType] = useState<DocumentType>(
    doc.documentType !== "unknown" ? doc.documentType : "lab_report",
  );

  const verdict = describeVerdict(doc);
  const size = formatSize(doc.sizeBytes);

  async function retry(documentType?: DocumentType) {
    setPending(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/documents/${doc.id}/retry`, {
        method: "POST",
        ...(documentType
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ documentType }),
            }
          : {}),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `retry failed (${response.status})`);
      }
      onAction();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "retry failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/documents/${doc.id}`}
            className="block truncate text-sm font-medium hover:underline"
          >
            {doc.filename}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[size, `uploaded ${formatTime(doc.uploadedAt)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StatusBadge status={doc.status} />
      </div>

      {doc.status !== "ignored" && <StageStepper doc={doc} />}

      {verdict && doc.status !== "uploaded" && (
        <Link
          href={`/documents/${doc.id}`}
          className="group flex items-center gap-1 text-xs text-sky-400 hover:underline"
        >
          {verdict}
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}

      {doc.status === "ignored" && (
        <p className="text-xs text-muted-foreground">
          Classified as not health-related — nothing was extracted.
        </p>
      )}

      {doc.status === "failed" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-red-400">
            {doc.stageError?.message ?? "Processing failed."}
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void retry()}
            >
              <RotateCcw className="size-3.5" />
              Retry
            </Button>
          </div>
        </div>
      )}

      {doc.status === "needs_review" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-amber-400">
            {doc.stageError?.message ??
              "The pipeline needs a hint to finish this document."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void retry()}
            >
              <RotateCcw className="size-3.5" />
              Retry
            </Button>
            <span className="text-xs text-muted-foreground">or</span>
            <select
              value={processType}
              disabled={pending}
              onChange={(event) =>
                setProcessType(event.target.value as DocumentType)
              }
              className="h-7 rounded-lg border border-input bg-input/30 px-2 text-xs text-foreground outline-none focus-visible:border-ring"
              aria-label="Process as document type"
            >
              {PROCESS_AS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanize(type)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => void retry(processType)}
            >
              Process as…
            </Button>
          </div>
        </div>
      )}

      {actionError && <p className="text-xs text-red-400">{actionError}</p>}
    </div>
  );
}
