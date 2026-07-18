import { FlagCard, InsightCard } from "@/components/insight-card";
import type { InsightsData } from "@/lib/insights";

/**
 * The /insights feed: deterministic flag cards (pure rule engine over the
 * latest lab values) followed by the AI insight cards with cited sources.
 * Purely presentational — the page loads InsightsData from the DB.
 */
export function InsightsView({ data }: { data: InsightsData }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deterministic flags from your latest lab values, plus AI observations
          with cited sources.
        </p>
      </div>

      {data.flags.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            {`Flags (${data.flags.length})`}
          </h2>
          <div className="flex flex-col gap-2">
            {data.flags.map((card) => (
              <FlagCard
                key={`${card.slug}:${card.flag.kind}:${card.flag.date}`}
                slug={card.slug}
                name={card.name}
                flag={card.flag}
              />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-tight">
          {`AI insights (${data.insights.length})`}
        </h2>
        {data.insights.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No insights yet — they appear here after a lab report is ingested.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.insights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
