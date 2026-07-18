// CSV streaming + scalar coercion helpers for the wearable parser plugins.
//
// This module runs in the worker container under plain node type stripping
// (see worker/ingestion.ts), so every relative import in its graph must carry
// an explicit .ts extension and only zero-dependency packages are allowed.

import type { Readable } from "node:stream";

import Papa from "papaparse";

/** One CSV data row keyed by its (trimmed) header names. */
export type CsvRow = Record<string, string>;

/**
 * Parses a CSV stream header-row → objects via papaparse's streaming step
 * callback, so memory stays bounded by one row, not the file. Weird bytes,
 * ragged rows and quoting breakage are papaparse-tolerated (reported in
 * results.errors, which we deliberately ignore — partial data beats a crash);
 * only a hard stream/parse failure rejects.
 */
export function streamCsvRows(
  stream: Readable,
  onRow: (row: CsvRow) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRow>(stream, {
      header: true,
      skipEmptyLines: "greedy",
      // Duplicate source columns (Google Fit repeats "Calories (kcal)") are
      // renamed _1/_2 by papaparse itself; we only consume unique columns.
      transformHeader: (header) => header.trim(),
      step: (results) => {
        onRow(results.data);
      },
      complete: () => resolve(),
      error: (error: Error) => reject(error),
    });
  });
}

/**
 * Reads just the header line of a CSV stream (stops at the first newline or a
 * 64 KiB cap) and returns the column names, quote-aware. The stream is
 * abandoned mid-flight, so callers must treat it as disposable and open a
 * fresh one for the real parse.
 */
export async function sniffCsvHeaders(stream: Readable): Promise<string[]> {
  let text = "";
  for await (const chunk of stream) {
    text += (chunk as Buffer | string).toString();
    const newline = text.indexOf("\n");
    if (newline >= 0) {
      text = text.slice(0, newline);
      break;
    }
    if (text.length >= 65_536) break; // header line absurdly long: give up
  }
  text = text.replace(/^\uFEFF/, "").trim(); // strip BOM
  if (text === "") return [];
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  return (parsed.data[0] ?? []).map((header) => String(header).trim());
}

/**
 * Coerces a raw CSV cell to a finite number: trims, strips thousands
 * separators (commas/inner spaces), rejects blanks and garbage as undefined
 * (callers skip the metric — a dirty cell never fails the file).
 */
export function toNumber(raw: string | undefined | null): number | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.trim().replace(/[,\s]+/g, "");
  if (cleaned === "") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Coerces a raw CSV cell to an ISO calendar date (YYYY-MM-DD). Supports the
 * two shapes the wearable exports actually use — ISO 8601 dates/datetimes
 * (date part taken verbatim from the string, so timezone shifts never move a
 * day) and US-style MM/DD/YYYY — and returns null for anything else.
 */
export function toIsoDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return buildDate(iso[1], iso[2], iso[3]);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (us) {
    return buildDate(us[3], us[1].padStart(2, "0"), us[2].padStart(2, "0"));
  }
  return null;
}

function buildDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  // Range-check via a real Date so 2024-13-40 never leaks through.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/** Lowercases + trims row keys so column matching is case-insensitive. */
export function normalizeRow(row: CsvRow): CsvRow {
  const normalized: CsvRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim().toLowerCase()] = value;
  }
  return normalized;
}

/** First non-empty cell among candidate (lowercase) column names. */
export function firstCell(
  row: CsvRow,
  columns: readonly string[],
): string | undefined {
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return undefined;
}

/** Lowercased, trimmed header list for detection scoring. */
export function normalizeHeaders(headers: string[]): string[] {
  return headers.map((header) => header.trim().toLowerCase());
}
