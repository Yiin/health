import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { db } from "@/db";
import {
  getBiomarkerBySlug,
  getTrend,
  listInsightsForBiomarker,
  listResultsForBiomarker,
} from "@/db/repos/biomarker-results";
import {
  categoryLabel,
  displayFlag,
  effectiveResult,
  effectiveValueCanonical,
} from "@/lib/labs";
import { EditedPill, StatusPill } from "@/components/labs/status-pill";
import { ResultsTable, type DrawRow } from "@/components/labs/results-table";
import { TrendChart } from "@/components/labs/trend-chart";

// Reads the database per request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default async function BiomarkerPage({
  params,
}: {
  params: Promise<{ biomarker: string }>;
}) {
  const { biomarker } = await params;
  const slug = decodeURIComponent(biomarker);
  const catalogEntry = await getBiomarkerBySlug(db, slug);
  if (!catalogEntry) notFound();

  const [trend, results, insights] = await Promise.all([
    getTrend(db, slug),
    listResultsForBiomarker(db, slug),
    listInsightsForBiomarker(db, slug),
  ]);

  // Chart values are canonical; edited rows recompute from the override.
  const chartPoints = trend.map((point) => ({
    date: point.measuredOn,
    value: effectiveValueCanonical(point, catalogEntry),
    refLow: point.refLow,
    refHigh: point.refHigh,
    labName: point.labName,
  }));

  const latest = results[0] ?? null;
  const latestEffective = latest ? effectiveResult(latest) : null;

  const rows: DrawRow[] = results.map((result) => ({
    id: result.id,
    ...effectiveResult(result),
    flag: displayFlag(result, catalogEntry),
    refText: result.refText,
    labName: result.labName,
    documentId: result.documentId,
    documentFilename: result.documentFilename,
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <Link
        href="/labs"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Labs
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {catalogEntry.name}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
          <span>{categoryLabel(catalogEntry.category)}</span>
          <span>Canonical unit: {catalogEntry.canonicalUnit}</span>
          {latest && latestEffective && (
            <span className="flex items-center gap-1.5">
              <span className="font-medium text-foreground tabular-nums">
                {latestEffective.value} {latestEffective.unit}
              </span>
              <span>on {latestEffective.measuredOn}</span>
              <StatusPill flag={displayFlag(latest, catalogEntry)} />
              {latestEffective.edited && <EditedPill />}
            </span>
          )}
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
        <h2 className="mb-3 text-sm font-semibold tracking-tight">
          Trend ({catalogEntry.canonicalUnit})
        </h2>
        {chartPoints.length === 0 ? (
          <p className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No results for this biomarker yet.
          </p>
        ) : (
          <TrendChart points={chartPoints} unit={catalogEntry.canonicalUnit} />
        )}
      </section>

      {rows.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            All draws ({rows.length})
          </h2>
          <ResultsTable biomarkerSlug={slug} rows={rows} />
          <p className="text-xs text-muted-foreground">
            Edits are saved as overrides on top of the AI extraction — the raw
            extracted values are never overwritten.
          </p>
        </section>
      )}

      {insights.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Insights ({insights.length})
          </h2>
          <div className="flex flex-col gap-3">
            {insights.map((insight) => (
              <article
                key={insight.id}
                className="rounded-lg border border-border bg-card p-4 text-card-foreground"
              >
                <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold tracking-tight">
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
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
