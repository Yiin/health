"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ResultFlag } from "@/db/schema";
import { Button } from "@/components/ui/button";

import { formatLabValue } from "./labs-client";
import { EditedPill, StatusPill } from "./status-pill";

export interface DrawRow {
  id: string;
  /** Effective (override-aware) values. */
  measuredOn: string;
  value: number;
  unit: string;
  /** Recomputed from the effective canonical value vs the reference range. */
  flag: ResultFlag | null;
  edited: boolean;
  refText: string | null;
  labName: string | null;
  documentId: string | null;
  documentFilename: string | null;
}

const CONTROL_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-input/30 px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

interface Draft {
  measuredOn: string;
  value: string;
  unit: string;
}

/**
 * All draws for one biomarker, most recent first, with inline editing.
 * Edits persist as user overrides via PATCH /api/labs/[biomarker]/results/[id]
 * — the raw AI extraction stays untouched — and the row's range status is
 * recomputed from the edited value.
 */
export function ResultsTable({
  biomarkerSlug,
  rows: initialRows,
}: {
  biomarkerSlug: string;
  rows: DrawRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(row: DrawRow) {
    setEditingId(row.id);
    setDraft({
      measuredOn: row.measuredOn,
      value: String(row.value),
      unit: row.unit,
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setError(null);
  }

  async function saveEdit(id: string) {
    if (!draft) return;
    const value = Number(draft.value);
    if (!Number.isFinite(value)) {
      setError("Value must be a number");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/labs/${biomarkerSlug}/results/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value,
          measuredOn: draft.measuredOn,
          unit: draft.unit,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Save failed (${response.status})`);
      }
      const body = (await response.json()) as {
        result: {
          id: string;
          measuredOn: string;
          value: number;
          unit: string;
          flag: ResultFlag | null;
          edited: boolean;
          refText: string | null;
          labName: string | null;
        };
      };
      setRows((current) =>
        current.map((row) =>
          row.id === id ? { ...row, ...body.result } : row,
        ),
      );
      setEditingId(null);
      setDraft(null);
      // Re-render the server page so the chart and header reflect the edit.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Value</th>
            <th className="px-3 py-2 font-medium">Unit</th>
            <th className="px-3 py-2 font-medium">Reference</th>
            <th className="px-3 py-2 font-medium">Lab</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) =>
            editingId === row.id && draft ? (
              <tr key={row.id} className="bg-muted/40">
                <td className="px-3 py-2">
                  <input
                    type="date"
                    value={draft.measuredOn}
                    onChange={(event) =>
                      setDraft({ ...draft, measuredOn: event.target.value })
                    }
                    className={CONTROL_CLASSES}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="any"
                    value={draft.value}
                    onChange={(event) =>
                      setDraft({ ...draft, value: event.target.value })
                    }
                    className={CONTROL_CLASSES}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={draft.unit}
                    onChange={(event) =>
                      setDraft({ ...draft, unit: event.target.value })
                    }
                    maxLength={50}
                    className={CONTROL_CLASSES}
                  />
                </td>
                <td className="px-3 py-2 text-muted-foreground" colSpan={4}>
                  {error && <span className="text-red-400">{error}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() => saveEdit(row.id)}
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={cancelEdit}
                    >
                      Cancel
                    </Button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={row.id}>
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.measuredOn}
                </td>
                <td className="px-3 py-2 font-medium tabular-nums">
                  {formatLabValue(row.value)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.unit}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.refText ?? "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.labName ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <StatusPill flag={row.flag} />
                    {row.edited && <EditedPill />}
                  </div>
                </td>
                <td className="max-w-40 truncate px-3 py-2">
                  {row.documentId ? (
                    <Link
                      href={`/documents/${row.documentId}`}
                      className="underline-offset-4 hover:underline"
                      title={row.documentFilename ?? undefined}
                    >
                      {row.documentFilename ?? "Document"}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => startEdit(row)}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
