// Client-safe helpers for the live ingestion feed (upload page + overview
// status strip). No server-only imports: these run in the browser.

import { humanize } from "@/components/documents/badges";
import type {
  DocumentStatus,
  DocumentStageError,
  DocumentType,
} from "@/db/schema";

/** One feed document as it arrives over the wire (dates are ISO strings). */
export interface IngestionFeedDocument {
  id: string;
  filename: string;
  status: DocumentStatus;
  documentType: DocumentType;
  provider: string | null;
  documentDate: string | null;
  summary: string | null;
  uploadedAt: string;
  edited: boolean;
  stageError: DocumentStageError | null;
  sizeBytes: number | null;
  biomarkerCount: number;
}

export interface IngestionFeedResponse {
  documents: IngestionFeedDocument[];
  hasActive: boolean;
  polledAt: string;
}

// The pipeline stages the feed card stepper shows, in order. Terminal
// outcomes (failed / needs_review / ignored) are rendered off-stepper.
export const INGESTION_STAGES = [
  "uploaded",
  "classifying",
  "extracting",
  "normalizing",
  "done",
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

export interface FeedDocument extends IngestionFeedDocument {
  /**
   * When the poller first observed each status (ISO strings) — the DB only
   * persists the current status, so per-stage timestamps are observed
   * client-side at poll granularity. `uploaded` falls back to the
   * server-known uploadedAt.
   */
  observedAt: Partial<Record<DocumentStatus, string>>;
}

/**
 * Merges a fresh poll into the previous feed, carrying over observed-stage
 * timestamps and stamping any newly-seen status with `observedNow`. Documents
 * the server no longer returns drop out; order follows the server.
 */
export function mergeFeedDocuments(
  previous: FeedDocument[],
  next: IngestionFeedDocument[],
  observedNow: string,
): FeedDocument[] {
  const previousById = new Map(previous.map((doc) => [doc.id, doc]));
  return next.map((doc) => {
    const observedAt: Partial<Record<DocumentStatus, string>> = {
      ...previousById.get(doc.id)?.observedAt,
    };
    observedAt.uploaded ??= doc.uploadedAt;
    observedAt[doc.status] ??= observedNow;
    return { ...doc, observedAt };
  });
}

/**
 * The classifier's verdict line for a processed document, e.g.
 * "Lab report — 14 biomarkers, 2026-01-30". Null when there is nothing to
 * say yet (type unknown, no biomarkers, no date).
 */
export function describeVerdict(doc: {
  documentType: DocumentType;
  biomarkerCount: number;
  documentDate: string | null;
}): string | null {
  const typePart =
    doc.documentType !== "unknown" ? humanize(doc.documentType) : null;
  const detailParts: string[] = [];
  if (doc.biomarkerCount > 0) {
    detailParts.push(
      `${doc.biomarkerCount} biomarker${doc.biomarkerCount === 1 ? "" : "s"}`,
    );
  }
  if (doc.documentDate) {
    detailParts.push(doc.documentDate);
  }
  if (!typePart && detailParts.length === 0) return null;
  return [typePart, detailParts.join(", ")].filter(Boolean).join(" — ");
}

export type StageVisual = "done" | "current" | "failed" | "review" | "upcoming";

/**
 * Per-stage stepper state for a feed document. For in-flight and done
 * documents the current status maps directly onto the stepper; for
 * failed/needs_review the stage_error's stage marks where the run stopped
 * (unknown/missing stage → everything past `uploaded` stays upcoming). For
 * terminal-non-error states see the caller: ignored documents render no
 * stepper at all.
 */
export function stageVisuals(doc: {
  status: DocumentStatus;
  stageError?: DocumentStageError | null;
}): Record<IngestionStage, StageVisual> {
  const stages = {} as Record<IngestionStage, StageVisual>;

  if (doc.status === "failed" || doc.status === "needs_review") {
    const failedStage = INGESTION_STAGES.find(
      (stage) => stage !== "done" && stage === doc.stageError?.stage,
    );
    const failedIndex = failedStage ? INGESTION_STAGES.indexOf(failedStage) : 1;
    for (const [index, stage] of INGESTION_STAGES.entries()) {
      stages[stage] =
        index < failedIndex
          ? "done"
          : index === failedIndex
            ? doc.status === "failed"
              ? "failed"
              : "review"
            : "upcoming";
    }
    return stages;
  }

  const currentIndex = INGESTION_STAGES.findIndex(
    (stage) => stage === doc.status,
  );
  for (const [index, stage] of INGESTION_STAGES.entries()) {
    stages[stage] =
      index < currentIndex || doc.status === "done"
        ? "done"
        : index === currentIndex
          ? "current"
          : "upcoming";
  }
  return stages;
}

/** Short byte-size label for cards ("1.4 MB"); null when size is unknown. */
export function formatSize(sizeBytes: number | null): string | null {
  if (sizeBytes == null) return null;
  if (sizeBytes >= 1024 ** 3) {
    return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (sizeBytes >= 1024 ** 2) {
    return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.ceil(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}
