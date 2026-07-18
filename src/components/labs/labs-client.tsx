"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { ResultFlag } from "@/db/schema";
import { CATEGORY_ORDER, categoryLabel } from "@/lib/labs";

import { StatusPill } from "./status-pill";
import { TrendChart } from "./trend-chart";

interface LabEntry {
  slug: string;
  name: string;
  category: string;
  canonicalUnit: string;
  latest: {
    measuredOn: string;
    value: number;
    unit: string;
    valueCanonical: number | null;
    flag: ResultFlag | null;
    edited: boolean;
    refText: string | null;
    labName: string | null;
  } | null;
  trend: {
    date: string;
    value: number | null;
    refLow: number | null;
    refHigh: number | null;
  }[];
}

/** Compact display for lab magnitudes (5.5, 0.0831, 1234). */
export function formatLabValue(value: number): string {
  return Number(value.toPrecision(4)).toLocaleString("en-US");
}

function groupByCategory(entries: LabEntry[]): [string, LabEntry[]][] {
  const groups = new Map<string, LabEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.category) ?? [];
    group.push(entry);
    groups.set(entry.category, group);
  }
  const known = CATEGORY_ORDER.filter((category) => groups.has(category));
  const unknown = [...groups.keys()]
    .filter((category) => !CATEGORY_ORDER.includes(category))
    .sort();
  return [...known, ...unknown].map((category) => [
    category,
    groups.get(category)!,
  ]);
}

function BiomarkerCell({ entry }: { entry: LabEntry }) {
  const latest = entry.latest!;
  return (
    <Link
      href={`/labs/${entry.slug}`}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-card-foreground transition-colors hover:border-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium tracking-tight">{entry.name}</span>
        <StatusPill flag={latest.flag} />
      </div>
      <div className="text-lg font-semibold tabular-nums">
        {formatLabValue(latest.value)}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          {latest.unit}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {latest.measuredOn}
        {latest.labName ? ` · ${latest.labName}` : ""}
        {latest.edited ? " · edited" : ""}
      </div>
      <TrendChart
        variant="spark"
        points={entry.trend}
        unit={entry.canonicalUnit}
      />
    </Link>
  );
}

/**
 * The labs grid: measured biomarkers grouped by category, each cell with the
 * latest value, range status, and a sparkline; click-through to the detail
 * trend page. Biomarkers never measured are omitted — an empty catalog cell
 * carries no signal.
 */
export function LabsClient() {
  const [entries, setEntries] = useState<LabEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/labs")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load labs (${response.status})`);
        }
        return (await response.json()) as { biomarkers: LabEntry[] };
      })
      .then((body) => {
        if (!cancelled) setEntries(body.biomarkers);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }
  if (entries === null) {
    return <p className="text-sm text-muted-foreground">Loading labs…</p>;
  }

  const measured = entries.filter((entry) => entry.latest !== null);
  if (measured.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No lab results yet — drop a lab report PDF on the upload page and it
        will show up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groupByCategory(measured).map(([category, group]) => (
        <section key={category} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-muted-foreground uppercase">
            {categoryLabel(category)}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.map((entry) => (
              <BiomarkerCell key={entry.slug} entry={entry} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
