"use client";

import {
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface LabTrendPoint {
  /** YYYY-MM-DD. */
  date: string;
  /** Value in the biomarker's canonical unit (null = unconvertible). */
  value: number | null;
  refLow?: number | null;
  refHigh?: number | null;
  labName?: string | null;
}

interface ChartRow {
  ts: number;
  date: string;
  value: number | null;
  /** Set only on in-range points (drives the neutral scatter dots). */
  inValue?: number;
  /** Set only on out-of-range points (drives the red scatter dots). */
  outValue?: number;
  labName?: string | null;
}

const OUT_OF_RANGE = "#f87171"; // red-400
const BAND = "#34d399"; // emerald-400
const GOAL = "#fbbf24"; // amber-400

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" };

function isOutOfRange(point: LabTrendPoint): boolean {
  if (point.value == null) return false;
  if (point.refLow != null && point.value < point.refLow) return true;
  if (point.refHigh != null && point.value > point.refHigh) return true;
  return false;
}

function toRows(points: LabTrendPoint[]): ChartRow[] {
  return points.map((point) => ({
    ts: Date.parse(`${point.date}T00:00:00Z`),
    date: point.date,
    value: point.value,
    inValue:
      point.value != null && !isOutOfRange(point) ? point.value : undefined,
    outValue:
      point.value != null && isOutOfRange(point) ? point.value : undefined,
    labName: point.labName,
  }));
}

/** The reference band uses the most recent draw that reported a range. */
function referenceBand(points: LabTrendPoint[]): {
  low: number | null;
  high: number | null;
} | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point.refLow != null || point.refHigh != null) {
      return { low: point.refLow ?? null, high: point.refHigh ?? null };
    }
  }
  return null;
}

/** Y domain padded around every plotted number (values, band, goal). */
function yDomain(
  points: LabTrendPoint[],
  goal: number | null,
): [number, number] {
  const numbers = points.flatMap((point) =>
    [point.value, point.refLow, point.refHigh].filter(
      (n): n is number => n != null,
    ),
  );
  if (goal != null) numbers.push(goal);
  if (numbers.length === 0) return [0, 1];
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const pad = (max - min || Math.abs(max) || 1) * 0.08;
  return [min - pad, max + pad];
}

function formatDate(date: string, withYear: boolean): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "2-digit" } : {}),
    timeZone: "UTC",
  });
}

interface TooltipEntry {
  payload?: ChartRow;
}

function ChartTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  unit: string;
}) {
  const row = payload?.find((entry) => entry.payload?.value != null)?.payload;
  if (!active || !row) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-2.5 py-1.5">
      <div className="text-muted-foreground">{row.date}</div>
      <div className="font-medium text-foreground tabular-nums">
        {row.value} {unit}
      </div>
      {row.labName && (
        <div className="text-muted-foreground">{row.labName}</div>
      )}
    </div>
  );
}

/**
 * Biomarker trend chart: a connecting line plus scatter dots (lab draws are
 * irregular, so the x-axis is a true time scale), an emerald ReferenceArea
 * for the in-range band, red dots for out-of-range draws, and an optional
 * dashed goal line. `variant="spark"` strips axes/tooltip for grid cells.
 */
export function TrendChart({
  points,
  unit,
  goal = null,
  variant = "full",
  height,
}: {
  points: LabTrendPoint[];
  unit: string;
  goal?: number | null;
  variant?: "full" | "spark";
  height?: number;
}) {
  const spark = variant === "spark";
  const rows = toRows(points);
  const band = referenceBand(points);
  const domain = yDomain(points, goal);
  const withYear =
    rows.length > 1 && rows[rows.length - 1].ts - rows[0].ts > 366 * 86_400_000;
  const chartHeight = height ?? (spark ? 48 : 256);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={
            spark
              ? { top: 2, right: 2, bottom: 2, left: 2 }
              : { top: 4, right: 8, bottom: 0, left: 0 }
          }
        >
          {!spark && (
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
              tick={AXIS_TICK}
              tickFormatter={(ts: number) =>
                formatDate(new Date(ts).toISOString().slice(0, 10), withYear)
              }
            />
          )}
          {!spark && (
            <YAxis
              domain={domain}
              tickLine={false}
              axisLine={false}
              width={40}
              tick={AXIS_TICK}
              tickFormatter={(value: number) =>
                Number(value.toPrecision(3)).toLocaleString("en-US")
              }
            />
          )}
          {spark && <YAxis domain={domain} hide />}
          {band && (
            <ReferenceArea
              y1={band.low ?? domain[0]}
              y2={band.high ?? domain[1]}
              fill={BAND}
              fillOpacity={spark ? 0.14 : 0.08}
              stroke="none"
            />
          )}
          {goal != null && (
            <ReferenceLine
              y={goal}
              stroke={GOAL}
              strokeDasharray="4 3"
              strokeWidth={1}
            />
          )}
          {!spark && <Tooltip content={<ChartTooltip unit={unit} />} />}
          <Line
            dataKey="value"
            stroke="var(--chart-1)"
            strokeWidth={spark ? 1.25 : 1.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Scatter
            dataKey="inValue"
            fill="var(--chart-1)"
            isAnimationActive={false}
          />
          <Scatter
            dataKey="outValue"
            fill={OUT_OF_RANGE}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
