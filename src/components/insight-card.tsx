import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AiInsight, InsightKind } from "@/db/schema";
import { FLAG_KIND_LABELS, type FlagSeverity } from "@/lib/flags";
import {
  INSIGHT_KIND_LABELS,
  resolveSourceRef,
  type FlagCardData,
} from "@/lib/insights";
import { cn } from "@/lib/utils";

const BADGE_BASE =
  "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap";

const KIND_STYLES: Record<InsightKind, string> = {
  post_ingestion: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  biomarker_trend: "border-violet-400/30 bg-violet-400/10 text-violet-400",
  anomaly: "border-amber-400/30 bg-amber-400/10 text-amber-400",
};

function InsightKindBadge({ kind }: { kind: InsightKind }) {
  return (
    <span className={cn(BADGE_BASE, KIND_STYLES[kind])}>
      {INSIGHT_KIND_LABELS[kind]}
    </span>
  );
}

/**
 * One ai_insights row: kind badge, title, date, the markdown body, and the
 * cited sources as dashboard links. Shared by /insights and the overview's
 * recent-insights section (the biomarker detail page has its own layout).
 */
export function InsightCard({ insight }: { insight: AiInsight }) {
  const sources = insight.sourceRefs
    .map(resolveSourceRef)
    .filter((ref) => ref !== null);
  return (
    <article className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        <InsightKindBadge kind={insight.kind} />
        <h3 className="min-w-0 flex-1 text-sm font-semibold tracking-tight">
          {insight.title ?? "Insight"}
        </h3>
        <span className="text-xs text-muted-foreground">
          {insight.createdAt.toISOString().slice(0, 10)}
        </span>
      </header>
      <div className="text-sm text-card-foreground/90 [&>p]:my-1 [&>ul]:my-1 [&>ul]:list-disc [&>ul]:pl-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {insight.bodyMd}
        </ReactMarkdown>
      </div>
      {sources.length > 0 && (
        <footer className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Sources:</span>
          {sources.map((source) => (
            <Link
              key={`${source.href}:${source.label}`}
              href={source.href}
              className="text-sky-400 underline-offset-4 hover:underline"
            >
              {source.label}
            </Link>
          ))}
        </footer>
      )}
    </article>
  );
}

const SEVERITY_STYLES: Record<FlagSeverity, string> = {
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  info: "border-sky-400/30 bg-sky-400/10 text-sky-400",
};

/**
 * One deterministic flag as a feed card: kind badge, biomarker name, the
 * flag's message, and the draw date. The whole card links to the biomarker's
 * trend page. Rendered by /insights from the flag engine (no LLM involved).
 */
export function FlagCard({ slug, name, flag }: FlagCardData) {
  return (
    <Link
      href={`/labs/${slug}`}
      className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:border-ring"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(BADGE_BASE, SEVERITY_STYLES[flag.severity])}>
            {FLAG_KIND_LABELS[flag.kind]}
          </span>
          <span className="text-sm font-semibold tracking-tight">{name}</span>
        </div>
        <p className="text-sm text-muted-foreground">{flag.message}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{flag.date}</span>
    </Link>
  );
}
