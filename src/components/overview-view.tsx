import Link from "next/link";

import { StatusBadge, TypeBadge } from "@/components/documents/badges";
import { InsightCard } from "@/components/insight-card";
import type { OverviewData, StatCard } from "@/lib/overview";

function StatCardView({ card }: { card: StatCard }) {
  return (
    <Link
      href={card.href}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-card-foreground transition-colors hover:border-ring"
    >
      <span className="text-xs text-muted-foreground">{card.label}</span>
      <span className="text-xl font-semibold tabular-nums">{card.value}</span>
      <span className="text-xs text-muted-foreground">{card.sub}</span>
    </Link>
  );
}

/**
 * The overview dashboard: stat cards (latest key vitals + labs in-range
 * ratio), the "needs attention" strip (flagged biomarkers + failed /
 * needs-review documents), recent AI insights, and recent uploads. Purely
 * presentational — the page loads OverviewData from the DB.
 */
export function OverviewView({ data }: { data: OverviewData }) {
  const needsAttention =
    data.flaggedBiomarkers.length > 0 || data.attentionDocuments.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {data.statCards.map((card) => (
          <StatCardView key={card.key} card={card} />
        ))}
      </section>

      {needsAttention && (
        <section className="flex flex-col gap-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-4">
          <h2 className="text-sm font-semibold tracking-tight text-amber-400">
            Needs attention
          </h2>
          {data.flaggedBiomarkers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.flaggedBiomarkers.map((biomarker) => (
                <Link
                  key={biomarker.slug}
                  href={`/labs/${biomarker.slug}`}
                  className="flex flex-col rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-ring"
                >
                  <span className="text-sm font-medium">{biomarker.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {biomarker.flags
                      .map((flag) => flag.shortLabel)
                      .join(" · ")}
                  </span>
                </Link>
              ))}
            </div>
          )}
          {data.attentionDocuments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {data.attentionDocuments.map((document) => (
                <Link
                  key={document.id}
                  href={`/documents/${document.id}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {document.filename}
                  </span>
                  <StatusBadge status={document.status} />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Recent insights
          </h2>
          <Link
            href="/insights"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            View all
          </Link>
        </div>
        {data.recentInsights.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No insights yet — they appear here after a lab report is ingested.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.recentInsights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Recent uploads
          </h2>
          <Link
            href="/documents"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            View all
          </Link>
        </div>
        {data.recentUploads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No documents yet — drop a lab report or wearable export on the
            upload page to get started.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.recentUploads.map((document) => (
              <Link
                key={document.id}
                href={`/documents/${document.id}`}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-ring"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {document.filename}
                </span>
                <TypeBadge type={document.documentType} />
                <StatusBadge status={document.status} />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {document.uploadedAt.toISOString().slice(0, 10)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
