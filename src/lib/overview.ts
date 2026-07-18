// Overview page view-model: the stat-card definitions (latest key vitals +
// the labs in-range ratio) and the single data load the page performs. Card
// building is pure (unit-tested without a DB); loadOverviewData assembles
// everything the overview renders from the repos.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { METRIC_UNITS, type MetricName } from "../db/metric-names";
import {
  getLatestMetricValues,
  type LatestMetricValue,
} from "../db/repos/daily-metrics";
import {
  listDocuments,
  listDocumentsNeedingAttention,
  type DocumentListItem,
} from "../db/repos/documents";
import { listInsights } from "../db/repos/insights";
import type { AiInsight } from "../db/schema";
import type * as schema from "../db/schema";

import {
  listFlaggedBiomarkers,
  summarizeInRange,
  type FlaggedBiomarker,
  type InRangeSummary,
} from "./attention";

type Db = PostgresJsDatabase<typeof schema>;

export interface StatCard {
  key: string;
  label: string;
  /** Formatted headline value ("8,432", "7h 12m", "34 / 38", or "—"). */
  value: string;
  /** Secondary line ("on 2026-07-15", "2 out of range", "no data yet"). */
  sub: string;
  href: string;
}

/** The key vitals shown as stat cards, in display order. */
const METRIC_CARDS: { metric: MetricName; label: string }[] = [
  { metric: "steps", label: "Steps" },
  { metric: "resting_hr", label: "Resting HR" },
  { metric: "hrv_ms", label: "HRV" },
  { metric: "sleep_total_min", label: "Sleep" },
  { metric: "weight_kg", label: "Weight" },
];

/** Headline formatting per metric: sleep as hours+minutes, steps grouped. */
export function formatMetricValue(metric: string, value: number): string {
  if (metric.startsWith("sleep_")) {
    const totalMinutes = Math.round(value);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  if (metric === "steps") return Math.round(value).toLocaleString("en-US");
  return `${Number(value.toPrecision(4)).toLocaleString("en-US")} ${METRIC_UNITS[metric as MetricName] ?? ""}`.trim();
}

/**
 * Stat cards for the overview: one per key vital (em dash when the metric
 * has no data yet) plus the labs in-range ratio (judged biomarkers only —
 * measured but unjudgeable ones are excluded from the denominator).
 */
export function buildStatCards(
  latestMetrics: LatestMetricValue[],
  inRange: InRangeSummary,
): StatCard[] {
  const latestByMetric = new Map(
    latestMetrics.map((row) => [row.metric, row]),
  );
  const cards: StatCard[] = METRIC_CARDS.map(({ metric, label }) => {
    const latest = latestByMetric.get(metric);
    return {
      key: metric,
      label,
      value: latest ? formatMetricValue(metric, latest.value) : "—",
      sub: latest ? `on ${latest.metricOn}` : "no data yet",
      href: "/vitals",
    };
  });

  const judged = inRange.inRange + inRange.outOfRange;
  cards.push({
    key: "labs-in-range",
    label: "Labs in range",
    value: judged > 0 ? `${inRange.inRange} / ${judged}` : "—",
    sub:
      judged === 0
        ? "no lab results yet"
        : inRange.outOfRange > 0
          ? `${inRange.outOfRange} out of range`
          : "all in range",
    href: "/labs",
  });
  return cards;
}

export interface OverviewData {
  statCards: StatCard[];
  flaggedBiomarkers: FlaggedBiomarker[];
  attentionDocuments: DocumentListItem[];
  recentInsights: AiInsight[];
  recentUploads: DocumentListItem[];
}

/** Everything the overview renders, in one parallel round of queries. */
export async function loadOverviewData(db: Db): Promise<OverviewData> {
  const [
    latestMetrics,
    inRange,
    flaggedBiomarkers,
    attentionDocuments,
    recentInsights,
    recentUploads,
  ] = await Promise.all([
    getLatestMetricValues(db),
    summarizeInRange(db),
    listFlaggedBiomarkers(db),
    listDocumentsNeedingAttention(db, { limit: 10 }),
    listInsights(db, { limit: 3 }),
    listDocuments(db, { limit: 5 }),
  ]);
  return {
    statCards: buildStatCards(latestMetrics, inRange),
    flaggedBiomarkers,
    attentionDocuments,
    recentInsights,
    recentUploads,
  };
}
