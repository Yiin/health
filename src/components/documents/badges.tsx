import type { DocumentStatus, DocumentType } from "@/db/schema";
import { cn } from "@/lib/utils";

const BADGE_BASE =
  "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap";

export function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const STATUS_STYLES: Record<DocumentStatus, string> = {
  uploaded: "border-zinc-400/30 bg-zinc-400/10 text-zinc-400",
  classifying: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  extracting: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  normalizing: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  done: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
  failed: "border-red-400/30 bg-red-400/10 text-red-400",
  needs_review: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  ignored: "border-zinc-500/30 bg-zinc-500/10 text-zinc-500",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={cn(BADGE_BASE, STATUS_STYLES[status])}>
      {humanize(status)}
    </span>
  );
}

export function TypeBadge({ type }: { type: DocumentType }) {
  return (
    <span
      className={cn(BADGE_BASE, "border-border bg-muted text-muted-foreground")}
    >
      {humanize(type)}
    </span>
  );
}

/** Shown once any manual metadata edit has been saved. */
export function EditedBadge() {
  return (
    <span
      className={cn(
        BADGE_BASE,
        "border-amber-400/30 bg-amber-400/10 text-amber-400",
      )}
      title="Metadata was edited manually; edits win over extracted values"
    >
      Edited
    </span>
  );
}

const FLAG_STYLES: Record<string, string> = {
  low: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  normal: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
  high: "border-red-400/30 bg-red-400/10 text-red-400",
};

export function FlagBadge({ flag }: { flag: string }) {
  return (
    <span
      className={cn(
        BADGE_BASE,
        FLAG_STYLES[flag] ?? "border-border bg-muted text-muted-foreground",
      )}
    >
      {humanize(flag)}
    </span>
  );
}
