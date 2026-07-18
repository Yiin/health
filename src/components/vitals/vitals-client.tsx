"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { MetricSeriesPayload } from "@/lib/vitals";

import { MetricChart, type ChartVariant } from "./metric-chart";
import { WorkoutsTable, type WorkoutItem } from "./workouts-table";

interface ChartDef {
  key: string;
  title: string;
  subtitle: string;
  metrics: string[];
  variant: ChartVariant;
}

const CHARTS: ChartDef[] = [
  {
    key: "steps",
    title: "Steps",
    subtitle: "steps per day",
    metrics: ["steps"],
    variant: "bar",
  },
  {
    key: "hrv",
    title: "HRV",
    subtitle: "milliseconds",
    metrics: ["hrv_ms"],
    variant: "line",
  },
  {
    key: "resting_hr",
    title: "Resting heart rate",
    subtitle: "bpm",
    metrics: ["resting_hr"],
    variant: "line",
  },
  {
    key: "sleep",
    title: "Sleep",
    subtitle: "hours per night — stacked stages, dashed total average",
    metrics: [
      "sleep_deep_min",
      "sleep_rem_min",
      "sleep_light_min",
      "sleep_total_min",
    ],
    variant: "sleep",
  },
];

const ALL_METRICS = [...new Set(CHARTS.flatMap((chart) => chart.metrics))];

async function fetchMetrics(
  metrics: string[],
  source?: string,
): Promise<Record<string, MetricSeriesPayload>> {
  const query = new URLSearchParams({ metric: metrics.join(",") });
  if (source) query.set("source", source);
  const response = await fetch(`/api/vitals?${query}`);
  if (!response.ok) throw new Error(`GET /api/vitals → ${response.status}`);
  const body = (await response.json()) as {
    metrics: Record<string, MetricSeriesPayload>;
  };
  return body.metrics;
}

/**
 * /vitals: one initial fetch for every chart (the API rolls older history up
 * server-side), per-chart source switching that refetches only that chart's
 * metrics, and the workouts table underneath.
 */
export function VitalsClient() {
  const [metrics, setMetrics] = useState<Record<
    string,
    MetricSeriesPayload
  > | null>(null);
  const [workouts, setWorkouts] = useState<WorkoutItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [metricPayloads, workoutsResponse] = await Promise.all([
          fetchMetrics(ALL_METRICS),
          fetch("/api/workouts"),
        ]);
        if (!workoutsResponse.ok) {
          throw new Error(`GET /api/workouts → ${workoutsResponse.status}`);
        }
        const workoutsBody = (await workoutsResponse.json()) as {
          workouts: WorkoutItem[];
        };
        if (cancelled) return;
        setMetrics(metricPayloads);
        setWorkouts(workoutsBody.workouts);
        setError(null);
      } catch {
        if (cancelled) return;
        setError("Couldn't load vitals — check the connection and try again.");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const retry = () => setRetryKey((key) => key + 1);

  async function changeSource(chart: ChartDef, source: string) {
    setSwitching(chart.key);
    setError(null);
    try {
      const payloads = await fetchMetrics(chart.metrics, source);
      setMetrics((previous) =>
        previous ? { ...previous, ...payloads } : previous,
      );
    } catch {
      setError(`Couldn't switch ${chart.title} to ${source} — try again.`);
    } finally {
      setSwitching(null);
    }
  }

  if (metrics === null) {
    return error ? (
      <p role="alert" className="text-sm text-red-400">
        {error}{" "}
        <Button variant="link" size="sm" onClick={retry}>
          try again
        </Button>
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading vitals…</p>
    );
  }

  const hasAnyData = Object.values(metrics).some(
    (payload) => payload.daily.length > 0 || payload.rollups.length > 0,
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}{" "}
          <Button variant="link" size="sm" onClick={retry}>
            try again
          </Button>
        </p>
      )}

      {hasAnyData ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {CHARTS.map((chart) => (
            <MetricChart
              key={chart.key}
              title={chart.title}
              subtitle={chart.subtitle}
              payloads={chart.metrics.map((metric) => metrics[metric])}
              variant={chart.variant}
              switching={switching === chart.key}
              onSourceChange={(source) => changeSource(chart, source)}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No wearable data yet — drop a Google Fit, Oura, Whoop, or Garmin
          export on the{" "}
          <Link href="/upload" className="text-sky-400 hover:underline">
            upload page
          </Link>{" "}
          and the charts appear here.
        </p>
      )}

      <section className="flex flex-col gap-3" aria-label="Workouts">
        <h2 className="text-sm font-semibold tracking-tight">Workouts</h2>
        {workouts === null ? (
          <p className="text-sm text-muted-foreground">Loading workouts…</p>
        ) : (
          <WorkoutsTable workouts={workouts} />
        )}
      </section>
    </div>
  );
}
