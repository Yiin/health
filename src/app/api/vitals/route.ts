import { db } from "@/db";
import { isMetricName, METRIC_UNITS, type MetricName } from "@/db/metric-names";
import { getMetricSeries, getMetricSources } from "@/db/repos/daily-metrics";
import {
  chooseGranularity,
  pickDefaultSource,
  rollupSeries,
  splitDailyWindow,
  withRollingAverage,
  type MetricSeriesPayload,
} from "@/lib/vitals";

/**
 * Chart series for the vitals dashboard.
 *
 *   GET /api/vitals?metric=steps,hrv_ms&source=oura&from=2025-01-01&to=2026-01-01
 *
 * `metric` (required, comma-separated) selects the metrics; every requested
 * metric gets its own payload keyed by name. `source` is one shared
 * preference applied per metric — a metric the source never reported falls
 * back to its freshest source. `from` (inclusive) / `to` (exclusive) bound
 * the raw series; without them the full history is returned.
 *
 * Multi-year daily data would mean thousands of points, so each payload is
 * split server-side: the most recent ~90 days of the series stay raw (with a
 * trailing 7-day average attached) and everything older comes back as weekly
 * rollups (monthly beyond ~13 months of history). Auth is enforced by the
 * proxy matcher (same as the other /api routes).
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const names = [
    ...new Set(
      (params.get("metric") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) {
    return badRequest("missing required query param: metric");
  }
  const unknown = names.filter((name) => !isMetricName(name));
  if (unknown.length > 0) {
    return badRequest(`unknown metric(s): ${unknown.join(", ")}`);
  }

  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  for (const [label, day] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (day !== undefined && !DAY_PATTERN.test(day)) {
      return badRequest(`${label} must be a YYYY-MM-DD date`);
    }
  }

  const requestedSource = params.get("source") ?? undefined;

  const metrics: Record<string, MetricSeriesPayload> = {};
  for (const name of names as MetricName[]) {
    const sources = await getMetricSources(db, name);
    const source =
      requestedSource && sources.some((s) => s.source === requestedSource)
        ? requestedSource
        : pickDefaultSource(sources);
    const series = source
      ? await getMetricSeries(db, name, { from, to, source })
      : [];
    const { daily, older } = splitDailyWindow(series);
    metrics[name] = {
      unit: METRIC_UNITS[name],
      sources: sources.map((s) => s.source),
      source: source ?? null,
      daily: withRollingAverage(daily),
      rollups: rollupSeries(older, chooseGranularity(older)),
    };
  }

  return Response.json({ metrics });
}
