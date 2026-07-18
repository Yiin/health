import type { ResultFlag } from "@/db/schema";
import { cn } from "@/lib/utils";

const PILL_BASE =
  "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap";

const PILL_STYLES: Record<ResultFlag, string> = {
  low: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  normal: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
  high: "border-red-400/30 bg-red-400/10 text-red-400",
};

const PILL_LABELS: Record<ResultFlag, string> = {
  low: "Low",
  normal: "In range",
  high: "High",
};

/** Reference-range status for a lab value ("In range" / "High" / "Low"). */
export function StatusPill({ flag }: { flag: ResultFlag | null }) {
  if (flag == null) {
    return (
      <span
        className={cn(
          PILL_BASE,
          "border-border bg-muted text-muted-foreground",
        )}
        title="No reference range reported"
      >
        No range
      </span>
    );
  }
  return (
    <span className={cn(PILL_BASE, PILL_STYLES[flag])}>
      {PILL_LABELS[flag]}
    </span>
  );
}

/** Shown on rows whose value/date/unit was edited manually. */
export function EditedPill() {
  return (
    <span
      className={cn(
        PILL_BASE,
        "border-amber-400/30 bg-amber-400/10 text-amber-400",
      )}
      title="Edited manually; the raw AI extraction is never overwritten"
    >
      Edited
    </span>
  );
}
