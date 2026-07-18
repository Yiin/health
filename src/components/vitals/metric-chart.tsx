"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { MetricSeriesPayload, RollupGranularity } from "@/lib/vitals";

export type ChartVariant = "bar" | "line" | "sleep";

interface ChartRow {
  label: string;
  value?: number;
  avg7?: number;
  rollup?: number;
  deep?: number;
  rem?: number;
  light?: number;
  rollupDeep?: number;
  rollupRem?: number;
  rollupLight?: number;
}

// The theme's chart colors are grayscale; the app accent (sky-400, see the
// upload page) marks the 7-day average and deep sleep so the lines read apart.
const ACCENT = "#38bdf8";
const REM = "#a78bfa";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" };

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function rollupLabel(start: string, granularity: RollupGranularity): string {
  if (granularity === "week") return dayLabel(start);
  return new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** Rollup rows first, then the raw daily window — one ascending axis. */
function singleMetricRows(payload: MetricSeriesPayload): ChartRow[] {
  return [
    ...payload.rollups.map((rollup) => ({
      label: rollupLabel(rollup.start, rollup.granularity),
      rollup: rollup.avg,
    })),
    ...payload.daily.map((point) => ({
      label: dayLabel(point.date),
      value: point.value,
      avg7: point.avg7,
    })),
  ];
}

/**
 * Merges the four sleep series (deep/rem/light/total) into one row per day or
 * bucket. Stage rollups share bucket boundaries because they come from the
 * same daily window; a stage missing a bucket simply renders as zero.
 */
function sleepRows(payloads: MetricSeriesPayload[]): ChartRow[] {
  const [deep, rem, light, total] = payloads;
  const remRollups = new Map(rem.rollups.map((r) => [r.start, r.avg]));
  const lightRollups = new Map(light.rollups.map((r) => [r.start, r.avg]));
  const remDaily = new Map(rem.daily.map((p) => [p.date, p.value]));
  const lightDaily = new Map(light.daily.map((p) => [p.date, p.value]));
  const totalAvg7 = new Map(total.daily.map((p) => [p.date, p.avg7]));

  return [
    ...deep.rollups.map((rollup) => ({
      label: rollupLabel(rollup.start, rollup.granularity),
      rollupDeep: hours(rollup.avg),
      rollupRem: hours(remRollups.get(rollup.start) ?? 0),
      rollupLight: hours(lightRollups.get(rollup.start) ?? 0),
    })),
    ...deep.daily.map((point) => {
      const totalPoint = totalAvg7.get(point.date);
      return {
        label: dayLabel(point.date),
        deep: hours(point.value),
        rem: hours(remDaily.get(point.date) ?? 0),
        light: hours(lightDaily.get(point.date) ?? 0),
        avg7: totalPoint === undefined ? undefined : hours(totalPoint),
      };
    }),
  ];
}

function SourceSelector({
  sources,
  current,
  onChange,
}: {
  sources: string[];
  current: string | null;
  onChange: (source: string) => void;
}) {
  if (sources.length === 0) return null;
  // One source: nothing to switch — show it as a plain label instead.
  if (sources.length === 1) {
    return <span className="text-xs text-muted-foreground">{sources[0]}</span>;
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Source
      <select
        value={current ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
      >
        {sources.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * One vitals chart card: daily resolution for the recent window, rollup
 * averages for older history, and a dashed 7-day rolling average on top.
 */
export function MetricChart({
  title,
  subtitle,
  payloads,
  variant,
  switching,
  onSourceChange,
}: {
  title: string;
  subtitle: string;
  /** One payload per plotted metric (single-metric charts: exactly one). */
  payloads: MetricSeriesPayload[];
  variant: ChartVariant;
  switching: boolean;
  onSourceChange: (source: string) => void;
}) {
  const sources = [...new Set(payloads.flatMap((p) => p.sources))];
  const current = payloads.find((p) => p.source)?.source ?? null;
  const rows =
    variant === "sleep" ? sleepRows(payloads) : singleMetricRows(payloads[0]);
  const formatTooltip = (
    value: number | string | readonly (number | string)[] | undefined,
  ) => {
    const single = Array.isArray(value) ? value[0] : value;
    if (variant === "sleep") return `${single} h`;
    return typeof single === "number" ? single.toLocaleString("en-US") : single;
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <SourceSelector
          sources={sources}
          current={current}
          onChange={onSourceChange}
        />
      </header>
      {rows.length === 0 ? (
        <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">
          No data for this metric yet.
        </p>
      ) : (
        <div
          className={`h-56 transition-opacity ${switching ? "opacity-40" : ""}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={32}
                tick={AXIS_TICK}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={36}
                tick={AXIS_TICK}
                tickFormatter={(value: number) =>
                  variant === "sleep" ? `${value}` : compactNumber.format(value)
                }
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: "var(--foreground)" }}
                formatter={formatTooltip}
              />
              {variant === "sleep" && (
                <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
              )}
              {variant === "bar" && (
                <Bar
                  dataKey="value"
                  name="Daily"
                  fill="var(--chart-1)"
                  radius={[2, 2, 0, 0]}
                />
              )}
              {variant === "bar" && (
                <Bar
                  dataKey="rollup"
                  name="Rollup avg"
                  fill="var(--chart-3)"
                  radius={[2, 2, 0, 0]}
                />
              )}
              {variant === "line" && (
                <Line
                  dataKey="value"
                  name="Daily"
                  stroke="var(--chart-1)"
                  strokeWidth={1.5}
                  dot={false}
                />
              )}
              {variant === "line" && (
                <Line
                  dataKey="rollup"
                  name="Rollup avg"
                  stroke="var(--chart-3)"
                  strokeWidth={1.5}
                  dot={false}
                />
              )}
              {variant === "sleep" && (
                <>
                  <Bar
                    dataKey="deep"
                    name="Deep"
                    stackId="daily"
                    fill={ACCENT}
                  />
                  <Bar dataKey="rem" name="REM" stackId="daily" fill={REM} />
                  <Bar
                    dataKey="light"
                    name="Light"
                    stackId="daily"
                    fill="var(--chart-3)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="rollupDeep"
                    name="Deep (rollup)"
                    stackId="rollup"
                    fill={ACCENT}
                    fillOpacity={0.45}
                    legendType="none"
                  />
                  <Bar
                    dataKey="rollupRem"
                    name="REM (rollup)"
                    stackId="rollup"
                    fill={REM}
                    fillOpacity={0.45}
                    legendType="none"
                  />
                  <Bar
                    dataKey="rollupLight"
                    name="Light (rollup)"
                    stackId="rollup"
                    fill="var(--chart-3)"
                    fillOpacity={0.45}
                    radius={[2, 2, 0, 0]}
                    legendType="none"
                  />
                  <Line
                    dataKey="avg7"
                    name="Total 7-day avg"
                    stroke="var(--chart-1)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                  />
                </>
              )}
              {variant !== "sleep" && (
                <Line
                  dataKey="avg7"
                  name="7-day avg"
                  stroke={ACCENT}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
